import { test } from 'tap';
import { StickTableStore } from '../aggregator';
import {
  ArrayTableValue,
  DictionaryTableValue,
  EntryUpdate,
  FrequencyCounterTableValue,
  StringTableKey,
  TableDefinition,
  TableValue,
  UnsignedInt32TableValue,
} from '../types';
import { DataType, FrequencyCounter, TableKeyType } from '../wire-types';

function definition(): TableDefinition {
  const dataTypeDefinitions = [
    { dataType: DataType.CONN_CNT },
    { dataType: DataType.CONN_RATE, period: 1000 },
    { dataType: DataType.SERVER_KEY },
    { dataType: DataType.GPT0 },
    { dataType: DataType.GPC_ARRAY, count: 2 },
  ];
  return {
    senderTableId: 1,
    name: 't',
    keyType: TableKeyType.STRING,
    keyLen: 0,
    dataTypes: dataTypeDefinitions.map((d) => d.dataType),
    dataTypeDefinitions,
    dataTypeParameters: new Map(
      dataTypeDefinitions.map((d) => [
        d.dataType,
        { count: (d as { count?: number }).count, period: d.period },
      ])
    ),
    expiry: 1000,
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

function update(values: Map<DataType, TableValue<unknown>>): EntryUpdate {
  return {
    updateId: 1,
    expiry: null,
    key: new StringTableKey('k'),
    values,
  };
}

void test('counters are summed across peers', (t) => {
  const store = new StickTableStore();
  const def = definition();

  store.applyUpdate(
    def,
    update(new Map([[DataType.CONN_CNT, new UnsignedInt32TableValue(3)]]))
  );
  store.applyUpdate(
    def,
    update(new Map([[DataType.CONN_CNT, new UnsignedInt32TableValue(4)]]))
  );

  const [entry] = store.getEntries('t');
  t.equal(
    (entry.values.get(DataType.CONN_CNT) as UnsignedInt32TableValue).value,
    7
  );
  t.end();
});

void test('tags take the most recent value', (t) => {
  const store = new StickTableStore();
  const def = definition();

  store.applyUpdate(
    def,
    update(new Map([[DataType.GPT0, new UnsignedInt32TableValue(1)]]))
  );
  store.applyUpdate(
    def,
    update(new Map([[DataType.GPT0, new UnsignedInt32TableValue(9)]]))
  );

  const [entry] = store.getEntries('t');
  t.equal(
    (entry.values.get(DataType.GPT0) as UnsignedInt32TableValue).value,
    9
  );
  t.end();
});

void test('frequency counters with the same tick are summed', (t) => {
  const store = new StickTableStore();
  const def = definition();

  store.applyUpdate(
    def,
    update(
      new Map([
        [DataType.CONN_RATE, new FrequencyCounterTableValue(freq(10, 2, 3))],
      ])
    )
  );
  store.applyUpdate(
    def,
    update(
      new Map([
        [DataType.CONN_RATE, new FrequencyCounterTableValue(freq(10, 5, 7))],
      ])
    )
  );

  const [entry] = store.getEntries('t');
  t.same(
    (entry.values.get(DataType.CONN_RATE) as FrequencyCounterTableValue).value,
    freq(10, 7, 10)
  );
  t.end();
});

void test('arrays are summed element-wise', (t) => {
  const store = new StickTableStore();
  const def = definition();

  store.applyUpdate(
    def,
    update(new Map([[DataType.GPC_ARRAY, new ArrayTableValue([1, 2])]]))
  );
  store.applyUpdate(
    def,
    update(new Map([[DataType.GPC_ARRAY, new ArrayTableValue([10, 20])]]))
  );

  const [entry] = store.getEntries('t');
  t.same(
    (entry.values.get(DataType.GPC_ARRAY) as ArrayTableValue<number>).value,
    [11, 22]
  );
  t.end();
});

void test('null dictionary values do not clobber a known value', (t) => {
  const store = new StickTableStore();
  const def = definition();

  store.applyUpdate(
    def,
    update(new Map([[DataType.SERVER_KEY, new DictionaryTableValue('web1')]]))
  );
  store.applyUpdate(
    def,
    update(new Map([[DataType.SERVER_KEY, new DictionaryTableValue(null)]]))
  );

  const [entry] = store.getEntries('t');
  t.equal(
    (entry.values.get(DataType.SERVER_KEY) as DictionaryTableValue).value,
    'web1'
  );
  t.end();
});
