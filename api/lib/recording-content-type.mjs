// Supabase Storage rejects Content-Type values that include parameters
// (for example "audio/wav; codecs=1"). Keep only the media type.

export function recordingContentType(header) {
  const mediaType = String(header || '')
    .split(';')[0]
    .trim();
  return mediaType || 'audio/wav';
}
