import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import tls from "node:tls";
import { StickTableStore } from "./aggregator";
import {
	DictionaryEncoder,
	encodeEntryUpdate,
	encodeHello,
	encodeTableDefinition,
} from "./encoder";
import { type InboundPeerConnection, PeerServer } from "./server";
import {
	type EntryUpdate,
	StringTableKey,
	type TableDefinition,
	UnsignedInt32TableValue,
} from "./types";
import { DataType, StatusMessageCode, TableKeyType } from "./wire-types";

const FIXTURE_SUBPATH = join("src", "fixtures", "tls");

function fixtureDir(): string {
	// Tests may run from source or from a compiled output dir, so search the
	// current working directory and the ancestors of this file for the fixtures.
	for (let dir of [process.cwd(), __dirname]) {
		for (;;) {
			const candidate = join(dir, FIXTURE_SUBPATH);
			if (existsSync(candidate)) {
				return candidate;
			}
			const parent = dirname(dir);
			if (parent === dir) {
				break;
			}
			dir = parent;
		}
	}
	throw new Error("could not locate TLS test fixtures");
}

function fixture(name: string): Buffer {
	return readFileSync(join(fixtureDir(), name));
}

const ca = fixture("ca-cert.pem");
const serverCert = fixture("server-cert.pem");
const serverKey = fixture("server-key.pem");
const clientCert = fixture("client-cert.pem");
const clientKey = fixture("client-key.pem");

function definition(): TableDefinition {
	return {
		senderTableId: 1,
		name: "web",
		keyType: TableKeyType.STRING,
		keyLen: 0,
		dataTypes: [DataType.CONN_CNT],
		dataTypeDefinitions: [{ dataType: DataType.CONN_CNT }],
		dataTypeParameters: new Map([[DataType.CONN_CNT, {}]]),
		expiry: 10000,
	};
}

function listen(server: PeerServer): Promise<number> {
	return new Promise((resolve) => {
		server.on("listening", () => {
			const address = server.address();
			resolve(typeof address === "object" && address ? address.port : 0);
		});
		server.listen(0, "127.0.0.1");
	});
}

test("server terminates TLS and aggregates updates", async () => {
	const store = new StickTableStore();
	const server = new PeerServer({
		localName: "aggregator",
		store,
		tls: { key: serverKey, cert: serverCert },
	});

	const established = new Promise<void>((resolve) => {
		server.on("connection", (conn: InboundPeerConnection) => {
			conn.on("error", () => undefined);
			conn.on("established", () => resolve());
		});
	});

	const port = await listen(server);

	const responses: Buffer[] = [];
	const socket = tls.connect({
		port,
		host: "127.0.0.1",
		servername: "localhost",
		ca: [ca],
	});
	const firstData = new Promise<void>((resolve) =>
		socket.once("data", () => resolve()),
	);
	socket.on("data", (chunk: Buffer) => responses.push(chunk));
	socket.on("error", () => undefined);

	await new Promise<void>((resolve) =>
		socket.on("secureConnect", () => resolve()),
	);

	socket.write(
		encodeHello({
			protocolVersion: "2.1",
			remotePeerName: "aggregator",
			localPeerName: "node1",
		}),
	);

	await Promise.all([established, firstData]);

	expect(Buffer.concat(responses).toString()).toMatch(
		new RegExp(`^${StatusMessageCode.HANDSHAKE_SUCCEEDED}`),
	);

	const def = definition();
	const dictionary = new DictionaryEncoder();
	const update: EntryUpdate = {
		updateId: 1,
		expiry: null,
		key: new StringTableKey("1.2.3.4"),
		values: new Map([[DataType.CONN_CNT, new UnsignedInt32TableValue(5)]]),
	};

	socket.write(
		Buffer.concat([
			encodeTableDefinition(def),
			encodeEntryUpdate(def, update, dictionary),
		]),
	);

	await new Promise<void>((resolve) => {
		const interval = setInterval(() => {
			if (store.getEntries("web").length > 0) {
				clearInterval(interval);
				resolve();
			}
		}, 10);
	});

	const [entry] = store.getEntries("web");
	expect(entry.key.key).toBe("1.2.3.4");
	expect(
		(entry.values.get(DataType.CONN_CNT) as UnsignedInt32TableValue).value,
	).toBe(5);

	socket.destroy();
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("server accepts a peer presenting a trusted client certificate", async () => {
	const server = new PeerServer({
		localName: "aggregator",
		tls: {
			key: serverKey,
			cert: serverCert,
			ca: [ca],
			requestCert: true,
			rejectUnauthorized: true,
		},
	});

	const established = new Promise<void>((resolve) => {
		server.on("connection", (conn: InboundPeerConnection) => {
			conn.on("error", () => undefined);
			conn.on("established", () => resolve());
		});
	});

	const port = await listen(server);

	const socket = tls.connect({
		port,
		host: "127.0.0.1",
		servername: "localhost",
		ca: [ca],
		key: clientKey,
		cert: clientCert,
	});
	// Ignore resets that can arrive during teardown.
	socket.on("error", () => undefined);

	await new Promise<void>((resolve) =>
		socket.on("secureConnect", () => resolve()),
	);

	socket.write(
		encodeHello({
			protocolVersion: "2.1",
			remotePeerName: "aggregator",
			localPeerName: "node1",
		}),
	);

	await established;
	// handshake completed over mutual TLS
	expect(true).toBe(true);

	socket.destroy();
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("server rejects a peer without a client certificate", async () => {
	const server = new PeerServer({
		localName: "aggregator",
		tls: {
			key: serverKey,
			cert: serverCert,
			ca: [ca],
			requestCert: true,
			rejectUnauthorized: true,
		},
	});

	const established = new Promise<"established">((resolve) => {
		server.on("connection", (conn: InboundPeerConnection) => {
			conn.on("error", () => undefined);
			conn.on("established", () => resolve("established"));
		});
	});

	const port = await listen(server);

	const socket = tls.connect({
		port,
		host: "127.0.0.1",
		servername: "localhost",
		ca: [ca],
	});
	socket.on("error", () => undefined);

	// Under TLS 1.3 the client's own handshake may complete (it verified the
	// server) before the server rejects the missing client certificate, so a
	// rejected peer surfaces as the connection closing rather than as an
	// authorization flag. Proceed like a real peer, then confirm the connection
	// is torn down without the application handshake ever establishing.
	const closed = new Promise<"closed">((resolve) => {
		socket.on("close", () => resolve("closed"));
	});
	socket.on("secureConnect", () => {
		socket.write(
			encodeHello({
				protocolVersion: "2.1",
				remotePeerName: "aggregator",
				localPeerName: "node1",
			}),
		);
	});

	const outcome = await Promise.race([established, closed]);
	expect(outcome).toBe("closed");

	socket.destroy();
	await new Promise<void>((resolve) => server.close(() => resolve()));
});
