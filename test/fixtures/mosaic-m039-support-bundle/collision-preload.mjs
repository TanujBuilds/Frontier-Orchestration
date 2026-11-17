import crypto from 'node:crypto';
import {syncBuiltinESMExports} from 'node:module';

// Deterministic exclusive-create collision; no production injection flag exists.
crypto.randomUUID=()=> 'fixture-collision';
syncBuiltinESMExports();
