import net from 'net';
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

function definition(): TableDefinition {
  const dataTypeDefinitions = [{ dataType: DataType.CONN_CNT }];
  return {
    senderTableId: 1,
    name: 'web',
    keyType: TableKeyType.STRING,
    keyLen: 0,
    dataTypes: [DataType.CONN_CNT],
    dataTypeDefinitions,
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

void test('server completes the handshake and aggregates updates', async (t) => {
  const store = new StickTableStore();
  const server = new PeerServer({ localName: 'aggregator', store });

  const established = new Promise<void>((resolve) => {
    server.on('connection', (conn: InboundPeerConnection) => {
      conn.on('established', () => resolve());
    });
  });

  const port = await listen(server);

  const responses: Buffer[] = [];
  const socket = net.connect(port, '127.0.0.1');
  const firstData = new Promise<void>((resolve) =>
    socket.once('data', () => resolve())
  );
  socket.on('data', (chunk) => responses.push(chunk));

  await new Promise<void>((resolve) => socket.on('connect', () => resolve()));

  socket.write(
    encodeHello({
      protocolVersion: '2.1',
      remotePeerName: 'aggregator',
      localPeerName: 'node1',
    })
  );

  await Promise.all([established, firstData]);

  // The first bytes returned must be the 200 status line.
  const status = Buffer.concat(responses).toString();
  t.match(status, new RegExp(`^${StatusMessageCode.HANDSHAKE_SUCCEEDED}`));

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

  // Wait until the store has absorbed the update.
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

void test('server rejects a peer name mismatch', async (t) => {
  const server = new PeerServer({ localName: 'aggregator' });
  const port = await listen(server);

  const responses: Buffer[] = [];
  const socket = net.connect(port, '127.0.0.1');
  socket.on('data', (chunk) => responses.push(chunk));
  await new Promise<void>((resolve) => socket.on('connect', () => resolve()));

  socket.write(
    encodeHello({
      protocolVersion: '2.1',
      remotePeerName: 'someone-else',
      localPeerName: 'node1',
    })
  );

  await new Promise<void>((resolve) => socket.on('close', () => resolve()));

  t.match(
    Buffer.concat(responses).toString(),
    new RegExp(`^${StatusMessageCode.REMOTE_PEER_IDENTIFIER_MISMATCH}`)
  );

  await new Promise<void>((resolve) => server.close(() => resolve()));
});
