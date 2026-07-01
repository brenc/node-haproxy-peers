import { expect, test } from "bun:test";
import { StickTableStore } from "./aggregator";
import {
	ArrayTableValue,
	DictionaryTableValue,
	type EntryUpdate,
	FrequencyCounterTableValue,
	StringTableKey,
	type TableDefinition,
	type TableValue,
	UnsignedInt32TableValue,
	UnsignedInt64TableValue,
} from "./types";
import { DataType, type FrequencyCounter, TableKeyType } from "./wire-types";

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
		name: "t",
		keyType: TableKeyType.STRING,
		keyLen: 0,
		dataTypes: dataTypeDefinitions.map((d) => d.dataType),
		dataTypeDefinitions,
		dataTypeParameters: new Map(
			dataTypeDefinitions.map((d) => [
				d.dataType,
				{ count: (d as { count?: number }).count, period: d.period },
			]),
		),
		expiry: 1000,
	};
}

function freq(
	tick: number,
	current: number,
	previous: number,
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
		key: new StringTableKey("k"),
		values,
	};
}

test("counters are summed across peers", () => {
	const store = new StickTableStore();
	const def = definition();

	store.applyUpdate(
		def,
		update(new Map([[DataType.CONN_CNT, new UnsignedInt32TableValue(3)]])),
	);
	store.applyUpdate(
		def,
		update(new Map([[DataType.CONN_CNT, new UnsignedInt32TableValue(4)]])),
	);

	const [entry] = store.getEntries("t");
	expect(
		(entry.values.get(DataType.CONN_CNT) as UnsignedInt32TableValue).value,
	).toBe(7);
});

test("64-bit counters are summed across peers", () => {
	const store = new StickTableStore();
	const def = definition();

	store.applyUpdate(
		def,
		update(new Map([[DataType.BYTES_IN_CNT, new UnsignedInt64TableValue(3n)]])),
	);
	store.applyUpdate(
		def,
		update(new Map([[DataType.BYTES_IN_CNT, new UnsignedInt64TableValue(4n)]])),
	);

	const [entry] = store.getEntries("t");
	expect(
		(entry.values.get(DataType.BYTES_IN_CNT) as UnsignedInt64TableValue).value,
	).toBe(7n);
});

test("tags take the most recent value", () => {
	const store = new StickTableStore();
	const def = definition();

	store.applyUpdate(
		def,
		update(new Map([[DataType.GPT0, new UnsignedInt32TableValue(1)]])),
	);
	store.applyUpdate(
		def,
		update(new Map([[DataType.GPT0, new UnsignedInt32TableValue(9)]])),
	);

	const [entry] = store.getEntries("t");
	expect(
		(entry.values.get(DataType.GPT0) as UnsignedInt32TableValue).value,
	).toBe(9);
});

test("frequency counters with the same tick are summed", () => {
	const store = new StickTableStore();
	const def = definition();

	store.applyUpdate(
		def,
		update(
			new Map([
				[DataType.CONN_RATE, new FrequencyCounterTableValue(freq(10, 2, 3))],
			]),
		),
	);
	store.applyUpdate(
		def,
		update(
			new Map([
				[DataType.CONN_RATE, new FrequencyCounterTableValue(freq(10, 5, 7))],
			]),
		),
	);

	const [entry] = store.getEntries("t");
	expect(
		(entry.values.get(DataType.CONN_RATE) as FrequencyCounterTableValue).value,
	).toEqual(freq(10, 7, 10));
});

test("arrays are summed element-wise", () => {
	const store = new StickTableStore();
	const def = definition();

	store.applyUpdate(
		def,
		update(new Map([[DataType.GPC_ARRAY, new ArrayTableValue([1, 2])]])),
	);
	store.applyUpdate(
		def,
		update(new Map([[DataType.GPC_ARRAY, new ArrayTableValue([10, 20])]])),
	);

	const [entry] = store.getEntries("t");
	expect(
		(entry.values.get(DataType.GPC_ARRAY) as ArrayTableValue<number>).value,
	).toEqual([11, 22]);
});

test("null dictionary values do not clobber a known value", () => {
	const store = new StickTableStore();
	const def = definition();

	store.applyUpdate(
		def,
		update(new Map([[DataType.SERVER_KEY, new DictionaryTableValue("web1")]])),
	);
	store.applyUpdate(
		def,
		update(new Map([[DataType.SERVER_KEY, new DictionaryTableValue(null)]])),
	);

	const [entry] = store.getEntries("t");
	expect(
		(entry.values.get(DataType.SERVER_KEY) as DictionaryTableValue).value,
	).toBe("web1");
});
