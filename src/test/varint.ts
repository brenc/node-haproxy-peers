import { test } from 'tap';
import { decode, decodeBigInt, encode } from '../varint';

void test('encode() tests', (t) => {
  // Test a number < 240.
  let encoded = encode(123);
  t.equal(encoded.toString('hex'), '7b');

  // Test a large number.
  encoded = encode(100000);
  t.equal(encoded.toString('hex'), 'f0db2f');

  encoded = encode(4294967296);
  t.equal(decode(encoded)[1], 4294967296);

  encoded = encode(1099511627776);
  t.equal(decode(encoded)[1], 1099511627776);

  t.end();
});

void test('decode() tests', (t) => {
  t.throws(() => {
    decode(Buffer.alloc(0));
  });

  let [consumed, decoded] = decode(Buffer.from([0x7b]));
  t.equal(consumed, 1);
  t.equal(decoded, 123);

  [consumed, decoded] = decode(Buffer.from([0xf0, 0xdb, 0x2f]));
  t.equal(consumed, 3);
  t.equal(decoded, 100000);

  [consumed, decoded] = decode(encode(4294967296));
  t.equal(consumed, encode(4294967296).length);
  t.equal(decoded, 4294967296);

  const bigValue = 9007199254740993n;
  const [bigConsumed, bigDecoded] = decodeBigInt(encode(bigValue));
  t.equal(bigConsumed, encode(bigValue).length);
  t.equal(bigDecoded, bigValue);

  t.throws(() => {
    // Try to decode an invalid buffer.
    decode(Buffer.from([0xf0, 0xf4]));
  });

  t.end();
});
