#!/usr/bin/env node
import { main } from './cli.ts';
main().then((code) => process.exit(code));
