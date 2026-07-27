/**
 * ingest/index.ts — barrel for the ingest subsystem.
 *
 * Re-exports the multi-content-type IngestPipeline (dispatch routing + handlers),
 * the URL fetcher, and the file reader.
 */

export { IngestPipeline, ContentTooLargeError } from "./pipeline.js";
export type { DispatchOpts, DispatchResult } from "./pipeline.js";

export { fetchUrl, SsrfBlockedError } from "./fetcher.js";

export { readFile, PathNotAllowedError } from "./file.js";
export type { ReadFileResult, ReadFileOptions } from "./file.js";
