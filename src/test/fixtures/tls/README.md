# TLS test fixtures

Throwaway, self-signed certificates used only by the test suite to exercise
`PeerServer`'s TLS / mutual-TLS support. They are **not secrets** and must not
be used outside the tests.

- `ca-cert.pem` / `ca-key.pem` — test certificate authority.
- `server-cert.pem` / `server-key.pem` — server cert (CN `localhost`, SAN
  `localhost` + `127.0.0.1`), signed by the CA.
- `client-cert.pem` / `client-key.pem` — client cert (CN `peer-client`), signed
  by the CA, for mutual-TLS tests.
