/**
 * Limits shared by the API (and mirrored in the media worker's settings).
 */
const LIMITS = {
  maxUploadBytes: 20 * 1024 ** 3,
  maxSourceMinutes: 240,
};

const CLIP_LIMITS = { minSeconds: 3, maxSeconds: 180 };

module.exports = { LIMITS, CLIP_LIMITS };
