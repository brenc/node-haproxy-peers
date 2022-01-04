import { test } from 'tap';
import { decode, encode } from '../varint';

void test('encode() tests', (t) => {
  // Test a number < 240.
  let encoded = encode(123);
  t.equal(encoded.toString('hex'), '7b');

  // Test a large number.
  encoded = encode(100000);
  t.equal(encoded.toString('hex'), 'f0db2f');

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

  t.throws(() => {
    // Try to decode an invalid buffer.
    decode(Buffer.from([0xf0, 0xf4]));
  });

  t.end();
});
