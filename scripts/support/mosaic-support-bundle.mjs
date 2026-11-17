#!/usr/bin/env node
import {runSupportBundle} from '../../src/beta/support-bundle.mjs';

process.exitCode=await runSupportBundle(process.argv.slice(2));
