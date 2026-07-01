import { expect, test } from "bun:test";
import { decode, decodeBigInt, encode } from "./varint";

test("encode() tests", () => {
	// Test a number < 240.
	let encoded = encode(123);
	expect(encoded.toString("hex")).toBe("7b");

	// Test a large number.
	encoded = encode(100000);
	expect(encoded.toString("hex")).toBe("f0db2f");

	encoded = encode(4294967296);
	expect(decode(encoded)[1]).toBe(4294967296);

	encoded = encode(1099511627776);
	expect(decode(encoded)[1]).toBe(1099511627776);
});

test("decode() tests", () => {
	expect(() => {
		decode(Buffer.alloc(0));
	}).toThrow();

	let [consumed, decoded] = decode(Buffer.from([0x7b]));
	expect(consumed).toBe(1);
	expect(decoded).toBe(123);

	[consumed, decoded] = decode(Buffer.from([0xf0, 0xdb, 0x2f]));
	expect(consumed).toBe(3);
	expect(decoded).toBe(100000);

	[consumed, decoded] = decode(encode(4294967296));
	expect(consumed).toBe(encode(4294967296).length);
	expect(decoded).toBe(4294967296);

	const bigValue = 9007199254740993n;
	const [bigConsumed, bigDecoded] = decodeBigInt(encode(bigValue));
	expect(bigConsumed).toBe(encode(bigValue).length);
	expect(bigDecoded).toBe(bigValue);

	expect(() => {
		// Try to decode an invalid buffer.
		decode(Buffer.from([0xf0, 0xf4]));
	}).toThrow();
});
