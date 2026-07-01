import { test } from 'tap';
import { StickTableStore } from '../aggregator';
import {
  DictionaryEncoder,
  encodeEntryUpdate,
  encodeTableDefinition,
} from '../encoder';
import * as messages from '../messages';
import PeerParser from '../protocol-parser';
import {
  ArrayTableValue,
  DictionaryTableValue,
  EntryUpdate,
  FrequencyCounterTableValue,
  StringTableKey,
  TableDefinition,
  TableValue,
  UnsignedInt32TableValue,
  UnsignedInt64TableValue,
} from '../types';
import { DataType, FrequencyCounter, TableKeyType } from '../wire-types';

/**
 * Feeds the given buffer through PeerParser and resolves with every message
 * that was decoded from it.
 */
function decodeAll(buffer: Buffer): Promise<messages.Message[]> {
  return new Promise((resolve, reject) => {
    const parser = new PeerParser();
    const decoded: messages.Message[] = [];
    parser.on('data', (message: messages.Message) => decoded.push(message));
    parser.on('error', reject);
    parser.on('end', () => resolve(decoded));
    parser.end(buffer);
  });
}

function buildDefinition(): TableDefinition {
  const dataTypeDefinitions = [
    { dataType: DataType.GPC0 },
    { dataType: DataType.CONN_CNT },
    { dataType: DataType.CONN_RATE, period: 1000 },
    { dataType: DataType.BYTES_IN_CNT },
    { dataType: DataType.SERVER_KEY },
    { dataType: DataType.GPT_ARRAY, count: 3 },
    { dataType: DataType.GPC_RATE_ARRAY, count: 2, period: 5000 },
  ];

  const dataTypeParameters = new Map<
    DataType,
    { count?: number; period?: number }
  >([
    [DataType.GPC0, {}],
    [DataType.CONN_CNT, {}],
    [DataType.CONN_RATE, { period: 1000 }],
    [DataType.BYTES_IN_CNT, {}],
    [DataType.SERVER_KEY, {}],
    [DataType.GPT_ARRAY, { count: 3 }],
    [DataType.GPC_RATE_ARRAY, { count: 2, period: 5000 }],
  ]);

  return {
    senderTableId: 7,
    name: 'aggregated',
    keyType: TableKeyType.STRING,
    keyLen: 32,
    dataTypes: dataTypeDefinitions.map((d) => d.dataType),
    dataTypeDefinitions,
    dataTypeParameters,
    expiry: 30000,
  };
}

function freq(
  tick: number,
  current: number,
  previous: number
): FrequencyCounter {
  return {
    currentTick: tick,
    currentCounter: current,
    previousCounter: previous,
  };
}

function buildUpdate(updateId: number, dictValue: string | null): EntryUpdate {
  const values = new Map<DataType, TableValue<unknown>>([
    [DataType.GPC0, new UnsignedInt32TableValue(11)],
    [DataType.CONN_CNT, new UnsignedInt32TableValue(42)],
    [DataType.CONN_RATE, new FrequencyCounterTableValue(freq(123, 4, 5))],
    [DataType.BYTES_IN_CNT, new UnsignedInt64TableValue(987654n)],
    [DataType.SERVER_KEY, new DictionaryTableValue(dictValue)],
    [DataType.GPT_ARRAY, new ArrayTableValue([1, 2, 3])],
    [
      DataType.GPC_RATE_ARRAY,
      new ArrayTableValue([freq(1, 10, 20), freq(2, 30, 40)]),
    ],
  ]);

  return {
    updateId,
    expiry: null,
    key: new StringTableKey('192.0.2.10'),
    values,
  };
}

void test('table definition round-trips through the parser', async (t) => {
  const definition = buildDefinition();
  const messagesOut = await decodeAll(encodeTableDefinition(definition));

  t.equal(messagesOut.length, 1);
  const decoded = messagesOut[0];
  t.ok(decoded instanceof messages.TableDefinition);
  if (decoded instanceof messages.TableDefinition) {
    t.equal(decoded.definition.name, 'aggregated');
    t.equal(decoded.definition.senderTableId, 7);
    t.equal(decoded.definition.keyType, TableKeyType.STRING);
    t.equal(decoded.definition.expiry, 30000);
    t.same(decoded.definition.dataTypes, definition.dataTypes);
    t.equal(
      decoded.definition.dataTypeParameters.get(DataType.CONN_RATE)?.period,
      1000
    );
    t.equal(
      decoded.definition.dataTypeParameters.get(DataType.GPC_RATE_ARRAY)?.count,
      2
    );
    t.equal(
      decoded.definition.dataTypeParameters.get(DataType.GPC_RATE_ARRAY)
        ?.period,
      5000
    );
    t.equal(
      decoded.definition.dataTypeParameters.get(DataType.GPT_ARRAY)?.count,
      3
    );
  }
});

void test('entry update round-trips through the parser', async (t) => {
  const definition = buildDefinition();
  const dictionary = new DictionaryEncoder();

  const buffer = Buffer.concat([
    encodeTableDefinition(definition),
    encodeEntryUpdate(definition, buildUpdate(1, 'web1'), dictionary),
    // Re-using the same dictionary value must resolve via the cache.
    encodeEntryUpdate(definition, buildUpdate(2, 'web1'), dictionary),
  ]);

  const out = await decodeAll(buffer);
  const updates = out.filter(
    (m): m is messages.EntryUpdate => m instanceof messages.EntryUpdate
  );
  t.equal(updates.length, 2);

  for (const update of updates) {
    t.equal(update.update.key.key, '192.0.2.10');
    t.equal(
      (update.update.values.get(DataType.CONN_CNT) as UnsignedInt32TableValue)
        .value,
      42
    );
    t.equal(
      (
        update.update.values.get(
          DataType.BYTES_IN_CNT
        ) as UnsignedInt64TableValue
      ).value,
      987654n
    );
    t.same(
      (update.update.values.get(DataType.GPT_ARRAY) as ArrayTableValue<number>)
        .value,
      [1, 2, 3]
    );
    t.same(
      (
        update.update.values.get(
          DataType.CONN_RATE
        ) as FrequencyCounterTableValue
      ).value,
      freq(123, 4, 5)
    );
    t.equal(
      (update.update.values.get(DataType.SERVER_KEY) as DictionaryTableValue)
        .value,
      'web1'
    );
  }
});

void test('entry values are ordered by data type, not declaration order', async (t) => {
  // Data types declared out of ascending numeric order; the encoder must still
  // emit values in the order the parser reads them (ascending) or values get
  // assigned to the wrong fields.
  const dataTypeDefinitions = [
    { dataType: DataType.CONN_CNT }, // 4
    { dataType: DataType.GPC0 }, // 2
    { dataType: DataType.GPT0 }, // 1
  ];
  const definition: TableDefinition = {
    senderTableId: 1,
    name: 'unsorted',
    keyType: TableKeyType.STRING,
    keyLen: 0,
    dataTypes: dataTypeDefinitions.map((d) => d.dataType),
    dataTypeDefinitions,
    dataTypeParameters: new Map(
      dataTypeDefinitions.map((d) => [d.dataType, {}])
    ),
    expiry: 1000,
  };

  const update: EntryUpdate = {
    updateId: 1,
    expiry: null,
    key: new StringTableKey('k'),
    values: new Map<DataType, TableValue<unknown>>([
      [DataType.CONN_CNT, new UnsignedInt32TableValue(400)],
      [DataType.GPC0, new UnsignedInt32TableValue(200)],
      [DataType.GPT0, new UnsignedInt32TableValue(100)],
    ]),
  };

  const out = await decodeAll(
    Buffer.concat([
      encodeTableDefinition(definition),
      encodeEntryUpdate(definition, update, new DictionaryEncoder()),
    ])
  );
  const [decoded] = out.filter(
    (m): m is messages.EntryUpdate => m instanceof messages.EntryUpdate
  );

  const get = (dt: DataType): number =>
    (decoded.update.values.get(dt) as UnsignedInt32TableValue).value;
  t.equal(get(DataType.CONN_CNT), 400);
  t.equal(get(DataType.GPC0), 200);
  t.equal(get(DataType.GPT0), 100);
});

void test('a partial stored entry can be re-encoded with defaults', async (t) => {
  // A peer requesting synchronization triggers re-encoding of stored entries.
  // Entries populated by partial updates must still encode every data type in
  // the definition rather than throwing on the missing ones.
  const definition = buildDefinition();
  const store = new StickTableStore();
  store.applyUpdate(definition, {
    updateId: 1,
    expiry: null,
    key: new StringTableKey('192.0.2.10'),
    values: new Map<DataType, TableValue<unknown>>([
      [DataType.CONN_CNT, new UnsignedInt32TableValue(42)],
    ]),
  });

  const [entry] = store.getEntries('aggregated');
  const out = await decodeAll(
    Buffer.concat([
      encodeTableDefinition(definition),
      encodeEntryUpdate(
        definition,
        {
          updateId: 1,
          expiry: entry.expiry,
          key: entry.key,
          values: entry.values,
        },
        new DictionaryEncoder()
      ),
    ])
  );
  const [decoded] = out.filter(
    (m): m is messages.EntryUpdate => m instanceof messages.EntryUpdate
  );

  t.equal(
    (decoded.update.values.get(DataType.CONN_CNT) as UnsignedInt32TableValue)
      .value,
    42
  );
  t.equal(
    (
      decoded.update.values.get(
        DataType.BYTES_IN_CNT
      ) as UnsignedInt64TableValue
    ).value,
    0n
  );
  t.equal(
    (decoded.update.values.get(DataType.SERVER_KEY) as DictionaryTableValue)
      .value,
    null
  );
  t.same(
    (decoded.update.values.get(DataType.GPT_ARRAY) as ArrayTableValue<number>)
      .value,
    [0, 0, 0]
  );
  t.same(
    (
      decoded.update.values.get(
        DataType.CONN_RATE
      ) as FrequencyCounterTableValue
    ).value,
    freq(0, 0, 0)
  );
});
