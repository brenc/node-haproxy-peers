import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import tls from 'tls';
import { test } from 'tap';
import { StickTableStore } from '../aggregator';
import {
  DictionaryEncoder,
  encodeEntryUpdate,
  encodeHello,
  encodeTableDefinition,
} from '../encoder';
import { InboundPeerConnection, PeerServer } from '../server';
import {
  EntryUpdate,
  StringTableKey,
  TableDefinition,
  UnsignedInt32TableValue,
} from '../types';
import { DataType, StatusMessageCode, TableKeyType } from '../wire-types';

const FIXTURE_SUBPATH = join('src', 'test', 'fixtures', 'tls');

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
  throw new Error('could not locate TLS test fixtures');
}

function fixture(name: string): Buffer {
  return readFileSync(join(fixtureDir(), name));
}

const ca = fixture('ca-cert.pem');
const serverCert = fixture('server-cert.pem');
const serverKey = fixture('server-key.pem');
const clientCert = fixture('client-cert.pem');
const clientKey = fixture('client-key.pem');

function definition(): TableDefinition {
  return {
    senderTableId: 1,
    name: 'web',
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
    server.on('listening', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
    server.listen(0, '127.0.0.1');
  });
}

void test('server terminates TLS and aggregates updates', async (t) => {
  const store = new StickTableStore();
  const server = new PeerServer({
    localName: 'aggregator',
    store,
    tls: { key: serverKey, cert: serverCert },
  });

  const established = new Promise<void>((resolve) => {
    server.on('connection', (conn: InboundPeerConnection) => {
      conn.on('error', () => undefined);
      conn.on('established', () => resolve());
    });
  });

  const port = await listen(server);

  const responses: Buffer[] = [];
  const socket = tls.connect({
    port,
    host: '127.0.0.1',
    servername: 'localhost',
    ca: [ca],
  });
  const firstData = new Promise<void>((resolve) =>
    socket.once('data', () => resolve())
  );
  socket.on('data', (chunk: Buffer) => responses.push(chunk));
  socket.on('error', () => undefined);

  await new Promise<void>((resolve) =>
    socket.on('secureConnect', () => resolve())
  );

  socket.write(
    encodeHello({
      protocolVersion: '2.1',
      remotePeerName: 'aggregator',
      localPeerName: 'node1',
    })
  );

  await Promise.all([established, firstData]);

  t.match(
    Buffer.concat(responses).toString(),
    new RegExp(`^${StatusMessageCode.HANDSHAKE_SUCCEEDED}`)
  );

  const def = definition();
  const dictionary = new DictionaryEncoder();
  const update: EntryUpdate = {
    updateId: 1,
    expiry: null,
    key: new StringTableKey('1.2.3.4'),
    values: new Map([[DataType.CONN_CNT, new UnsignedInt32TableValue(5)]]),
  };

  socket.write(
    Buffer.concat([
      encodeTableDefinition(def),
      encodeEntryUpdate(def, update, dictionary),
    ])
  );

  await new Promise<void>((resolve) => {
    const interval = setInterval(() => {
      if (store.getEntries('web').length > 0) {
        clearInterval(interval);
        resolve();
      }
    }, 10);
  });

  const [entry] = store.getEntries('web');
  t.equal(entry.key.key, '1.2.3.4');
  t.equal(
    (entry.values.get(DataType.CONN_CNT) as UnsignedInt32TableValue).value,
    5
  );

  socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

void test('server accepts a peer presenting a trusted client certificate', async (t) => {
  const server = new PeerServer({
    localName: 'aggregator',
    tls: {
      key: serverKey,
      cert: serverCert,
      ca: [ca],
      requestCert: true,
      rejectUnauthorized: true,
    },
  });

  const established = new Promise<void>((resolve) => {
    server.on('connection', (conn: InboundPeerConnection) => {
      conn.on('error', () => undefined);
      conn.on('established', () => resolve());
    });
  });

  const port = await listen(server);

  const socket = tls.connect({
    port,
    host: '127.0.0.1',
    servername: 'localhost',
    ca: [ca],
    key: clientKey,
    cert: clientCert,
  });
  // Ignore resets that can arrive during teardown.
  socket.on('error', () => undefined);

  await new Promise<void>((resolve) =>
    socket.on('secureConnect', () => resolve())
  );

  socket.write(
    encodeHello({
      protocolVersion: '2.1',
      remotePeerName: 'aggregator',
      localPeerName: 'node1',
    })
  );

  await established;
  t.pass('handshake completed over mutual TLS');

  socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

void test('server rejects a peer without a client certificate', async (t) => {
  const server = new PeerServer({
    localName: 'aggregator',
    tls: {
      key: serverKey,
      cert: serverCert,
      ca: [ca],
      requestCert: true,
      rejectUnauthorized: true,
    },
  });

  const established = new Promise<'established'>((resolve) => {
    server.on('connection', (conn: InboundPeerConnection) => {
      conn.on('error', () => undefined);
      conn.on('established', () => resolve('established'));
    });
  });

  const port = await listen(server);

  const socket = tls.connect({
    port,
    host: '127.0.0.1',
    servername: 'localhost',
    ca: [ca],
  });
  socket.on('error', () => undefined);

  // Under TLS 1.3 the client's own handshake may complete (it verified the
  // server) before the server rejects the missing client certificate, so a
  // rejected peer surfaces as the connection closing rather than as an
  // authorization flag. Proceed like a real peer, then confirm the connection
  // is torn down without the application handshake ever establishing.
  const closed = new Promise<'closed'>((resolve) => {
    socket.on('close', () => resolve('closed'));
  });
  socket.on('secureConnect', () => {
    socket.write(
      encodeHello({
        protocolVersion: '2.1',
        remotePeerName: 'aggregator',
        localPeerName: 'node1',
      })
    );
  });

  const outcome = await Promise.race([established, closed]);
  t.equal(outcome, 'closed', 'connection was rejected before establishing');

  socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
