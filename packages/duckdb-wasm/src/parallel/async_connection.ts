import * as arrow from 'apache-arrow';
import * as utils from '../utils';
import { AsyncDuckDB } from './async_bindings';
import { LogLevel, LogTopic, LogOrigin, LogEvent } from '../log';
import { ArrowInsertOptions, CSVInsertOptions, JSONInsertOptions } from '../bindings/insert_options';

/** A thin helper to memoize the connection id */
export class AsyncDuckDBConnection {
    /** The async duckdb */
    protected readonly _bindings: AsyncDuckDB;
    /** The conn handle */
    protected readonly _conn: number;

    constructor(bindings: AsyncDuckDB, conn: number) {
        this._bindings = bindings;
        this._conn = conn;
    }

    /** Access the database bindings */
    public get bindings(): AsyncDuckDB {
        return this._bindings;
    }

    /** Disconnect from the database */
    public async close(): Promise<void> {
        return this._bindings.disconnect(this._conn);
    }

    /** Brave souls may use this function to consume the underlying connection id */
    public useUnsafe<R>(callback: (bindings: AsyncDuckDB, conn: number) => R) {
        return callback(this._bindings, this._conn);
    }

    /** Run a query */
    public async runQuery<T extends { [key: string]: arrow.DataType } = any>(text: string): Promise<arrow.Table<T>> {
        this._bindings.logger.log({
            timestamp: new Date(),
            level: LogLevel.INFO,
            origin: LogOrigin.ASYNC_DUCKDB,
            topic: LogTopic.QUERY,
            event: LogEvent.RUN,
            value: text,
        });
        const buffer = await this._bindings.runQuery(this._conn, text);
        const reader = arrow.RecordBatchReader.from<T>(buffer);
        console.assert(reader.isSync());
        console.assert(reader.isFile());
        return arrow.Table.from(reader as arrow.RecordBatchFileReader);
    }

    /** Send a query */
    public async sendQuery<T extends { [key: string]: arrow.DataType } = any>(
        text: string,
    ): Promise<arrow.AsyncRecordBatchStreamReader<T>> {
        this._bindings.logger.log({
            timestamp: new Date(),
            level: LogLevel.INFO,
            origin: LogOrigin.ASYNC_DUCKDB,
            topic: LogTopic.QUERY,
            event: LogEvent.RUN,
            value: text,
        });
        const header = await this._bindings.sendQuery(this._conn, text);
        const iter = new AsyncResultStreamIterator(this._bindings, this._conn, header);
        const reader = await arrow.RecordBatchReader.from<T>(iter);
        console.assert(reader.isAsync());
        console.assert(reader.isStream());
        return reader as unknown as arrow.AsyncRecordBatchStreamReader<T>; // XXX
    }

    /** Create a prepared statement */
    public async prepareStatement<T extends { [key: string]: arrow.DataType } = any>(
        text: string,
    ): Promise<AsyncPreparedStatement> {
        const stmt = await this._bindings.createPrepared(this._conn, text);
        return new AsyncPreparedStatement<T>(this._bindings, this._conn, stmt);
    }

    /** Insert arrow vectors */
    public async insertArrowVectors<T extends { [key: string]: arrow.Vector } = any>(
        children: T,
        options: ArrowInsertOptions,
    ): Promise<void> {
        await this.insertArrowTable(arrow.Table.new(children), options);
    }
    /** Insert an arrow table */
    public async insertArrowTable(table: arrow.Table, options: ArrowInsertOptions): Promise<void> {
        if (table.schema.fields.length == 0) {
            console.warn(
                'The schema is empty! If you used arrow.Table.from, consider constructing schema and batches manually',
            );
        }
        await this.insertArrowBatches(table.schema, table.chunks, options);
    }
    /** Insert record batches */
    public async insertArrowBatches(
        schema: arrow.Schema,
        batches: Iterable<arrow.RecordBatch>,
        options: ArrowInsertOptions,
    ): Promise<void> {
        // Prepare the IPC stream writer
        const buffer = new utils.IPCBuffer();
        const writer = new arrow.RecordBatchStreamWriter().reset(buffer, schema);

        // Write all batches to the ipc buffer
        let first = true;
        for (const batch of batches) {
            if (!first) {
                await this._bindings.insertArrowFromIPCStream(this._conn, buffer.flush(), options);
            }
            first = false;
            writer.write(batch);
        }
        writer.finish();
        await this._bindings.insertArrowFromIPCStream(this._conn, buffer.flush(), options);
    }
    /** Insert an arrow table from an ipc stream */
    public async insertArrowFromIPCStream(buffer: Uint8Array, options: ArrowInsertOptions): Promise<void> {
        await this._bindings.insertArrowFromIPCStream(this._conn, buffer, options);
    }

    /** Insert csv file from path */
    public async insertCSVFromPath(text: string, options: CSVInsertOptions): Promise<void> {
        await this._bindings.insertCSVFromPath(this._conn, text, options);
    }
    /** Insert json file from path */
    public async insertJSONFromPath(text: string, options: JSONInsertOptions): Promise<void> {
        await this._bindings.insertJSONFromPath(this._conn, text, options);
    }
}

/** An async result stream iterator */
export class AsyncResultStreamIterator implements AsyncIterable<Uint8Array> {
    /** First chunk? */
    protected _first: boolean;
    /** Reached end of stream? */
    protected _depleted: boolean;
    /** In-flight */
    protected _inFlight: Promise<Uint8Array> | null;

    constructor(
        protected readonly db: AsyncDuckDB,
        protected readonly conn: number,
        protected readonly header: Uint8Array,
    ) {
        this._first = true;
        this._depleted = false;
        this._inFlight = null;
    }

    async next(): Promise<IteratorResult<Uint8Array>> {
        if (this._first) {
            this._first = false;
            return { done: false, value: this.header };
        }
        if (this._depleted) {
            return { done: true, value: null };
        }
        let buffer: Uint8Array;
        if (this._inFlight != null) {
            buffer = await this._inFlight;
            this._inFlight = null;
        } else {
            buffer = await this.db.fetchQueryResults(this.conn);
        }
        this._depleted = buffer.length == 0;
        if (!this._depleted) {
            this._inFlight = this.db.fetchQueryResults(this.conn);
        }
        return {
            done: this._depleted,
            value: buffer,
        };
    }

    [Symbol.asyncIterator]() {
        return this;
    }
}

/** A thin helper to bind the prepared statement id */
export class AsyncPreparedStatement<T extends { [key: string]: arrow.DataType } = any> {
    /** The bindings */
    protected readonly bindings: AsyncDuckDB;
    /** The connection id */
    protected readonly connectionId: number;
    /** The statement id */
    protected readonly statementId: number;

    /** Constructor */
    constructor(bindings: AsyncDuckDB, connectionId: number, statementId: number) {
        this.bindings = bindings;
        this.connectionId = connectionId;
        this.statementId = statementId;
    }

    /** Close a prepared statement */
    public async close() {
        await this.bindings.closePrepared(this.connectionId, this.statementId);
    }

    /** Run a prepared statement */
    public async run(params: any[]): Promise<arrow.Table<T>> {
        const buffer = await this.bindings.runPrepared(this.connectionId, this.statementId, params);
        const reader = arrow.RecordBatchReader.from<T>(buffer);
        console.assert(reader.isSync());
        console.assert(reader.isFile());
        return arrow.Table.from(reader as arrow.RecordBatchFileReader);
    }

    /** Send a prepared statement */
    public async send(params: any[]): Promise<arrow.AsyncRecordBatchStreamReader<T>> {
        const header = await this.bindings.sendPrepared(this.connectionId, this.statementId, params);
        const iter = new AsyncResultStreamIterator(this.bindings, this.connectionId, header);
        const reader = await arrow.RecordBatchReader.from<T>(iter);
        console.assert(reader.isAsync());
        console.assert(reader.isStream());
        return reader as unknown as arrow.AsyncRecordBatchStreamReader<T>; // XXX
    }
}
