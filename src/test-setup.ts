import { setDefaultTimeout } from "bun:test";

// Real PGlite startup makes many tests take several seconds.
setDefaultTimeout(30_000);
