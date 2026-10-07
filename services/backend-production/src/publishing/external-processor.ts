import { MediaProcessingUnavailableError } from "./processing/errors.js";

import type {
  ProcessorInput,
  ProcessorOutcome,
} from "./processing/media-processor.js";

/**
 * The Backend's processor when the separate media worker processes media
 * (`WORK_MEDIA_WORKER=external`). HTTP code only checks that a processor is
 * present (uploads are accepted and items wait in `processing` until the
 * worker runs); calling it is a wiring error and fails retryably.
 */
export const externalPublishingProcessor: {
  process(input: ProcessorInput): Promise<ProcessorOutcome>;
} = {
  process: async () => {
    throw new MediaProcessingUnavailableError(null);
  },
};
