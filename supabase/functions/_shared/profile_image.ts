import {
  ConfigurationFiles,
  Gravity,
  type IConfigurationFile,
  type IConfigurationFiles,
  ImageMagick,
  initializeImageMagick,
  MagickFormat,
} from "npm:@imagemagick/magick-wasm@0.0.41";

export const PROFILE_IMAGE_MAX_BYTES = 150 * 1024;
export const PROFILE_IMAGE_MAX_DIMENSION = 256;
export const PROFILE_IMAGE_MAX_PIXELS = 65_536;

export type ProfileImageType = "image/jpeg" | "image/webp";

export type ProfileImageInfo = {
  contentType: ProfileImageType;
  width: number;
  height: number;
};

export type EncodedProfileImage = ProfileImageInfo & {
  bytes: Uint8Array;
  sha256: string;
};

export class ProfileImageValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileImageValidationError";
  }
}

const readUint16BigEndian = (bytes: Uint8Array, offset: number) =>
  (bytes[offset] << 8) | bytes[offset + 1];

const readUint16LittleEndian = (bytes: Uint8Array, offset: number) =>
  bytes[offset] | (bytes[offset + 1] << 8);

const readUint24LittleEndian = (bytes: Uint8Array, offset: number) =>
  bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);

const readUint32LittleEndian = (bytes: Uint8Array, offset: number) =>
  (
    bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)
  ) >>> 0;

function ascii(bytes: Uint8Array, offset: number, length: number) {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function assertSafeDimensions(width: number, height: number) {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > PROFILE_IMAGE_MAX_DIMENSION ||
    height > PROFILE_IMAGE_MAX_DIMENSION ||
    width * height > PROFILE_IMAGE_MAX_PIXELS
  ) {
    throw new ProfileImageValidationError(
      "Profile pictures must be no larger than 256 by 256 pixels.",
    );
  }
}

const jpegStartOfFrameMarkers = new Set([
  0xc0,
  0xc1,
  0xc2,
  0xc3,
  0xc5,
  0xc6,
  0xc7,
  0xc9,
  0xca,
  0xcb,
  0xcd,
  0xce,
  0xcf,
]);

function inspectJpeg(bytes: Uint8Array): ProfileImageInfo {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new ProfileImageValidationError(
      "The upload is not a valid JPEG image.",
    );
  }

  let cursor = 2;
  let width = 0;
  let height = 0;
  let frameHeaders = 0;
  let scans = 0;

  while (cursor < bytes.length) {
    if (bytes[cursor] !== 0xff) {
      throw new ProfileImageValidationError("The JPEG structure is invalid.");
    }
    while (cursor < bytes.length && bytes[cursor] === 0xff) cursor += 1;
    if (cursor >= bytes.length) {
      throw new ProfileImageValidationError("The JPEG image is incomplete.");
    }

    const marker = bytes[cursor++];
    if (marker === 0x00) {
      throw new ProfileImageValidationError("The JPEG structure is invalid.");
    }
    if (marker === 0xd8) {
      throw new ProfileImageValidationError(
        "Multi-picture JPEG uploads are not allowed.",
      );
    }
    if (marker === 0xd9) {
      if (cursor !== bytes.length || frameHeaders !== 1 || scans < 1) {
        throw new ProfileImageValidationError("The JPEG image is incomplete.");
      }
      assertSafeDimensions(width, height);
      return { contentType: "image/jpeg", width, height };
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      throw new ProfileImageValidationError("The JPEG structure is invalid.");
    }
    if (cursor + 2 > bytes.length) {
      throw new ProfileImageValidationError("The JPEG image is incomplete.");
    }

    const segmentLength = readUint16BigEndian(bytes, cursor);
    if (segmentLength < 2 || cursor + segmentLength > bytes.length) {
      throw new ProfileImageValidationError("The JPEG image is incomplete.");
    }
    const payloadOffset = cursor + 2;
    const payloadLength = segmentLength - 2;

    if (
      marker === 0xe2 &&
      payloadLength >= 4 &&
      ascii(bytes, payloadOffset, 4) === "MPF\0"
    ) {
      throw new ProfileImageValidationError(
        "Multi-picture JPEG uploads are not allowed.",
      );
    }

    if (jpegStartOfFrameMarkers.has(marker)) {
      if (payloadLength < 6 || bytes[payloadOffset] !== 8) {
        throw new ProfileImageValidationError("The JPEG frame is unsupported.");
      }
      frameHeaders += 1;
      if (frameHeaders !== 1) {
        throw new ProfileImageValidationError(
          "Multi-frame JPEG uploads are not allowed.",
        );
      }
      height = readUint16BigEndian(bytes, payloadOffset + 1);
      width = readUint16BigEndian(bytes, payloadOffset + 3);
      assertSafeDimensions(width, height);
    } else if (marker === 0xdc) {
      throw new ProfileImageValidationError(
        "JPEG height overrides are not allowed.",
      );
    }

    cursor += segmentLength;
    if (marker !== 0xda) continue;

    scans += 1;
    let nextMarkerOffset = -1;
    while (cursor < bytes.length) {
      if (bytes[cursor] !== 0xff) {
        cursor += 1;
        continue;
      }

      const markerOffset = cursor;
      cursor += 1;
      while (cursor < bytes.length && bytes[cursor] === 0xff) cursor += 1;
      if (cursor >= bytes.length) break;
      const entropyMarker = bytes[cursor];
      if (
        entropyMarker === 0x00 ||
        (entropyMarker >= 0xd0 && entropyMarker <= 0xd7)
      ) {
        cursor += 1;
        continue;
      }
      nextMarkerOffset = markerOffset;
      break;
    }
    if (nextMarkerOffset < 0) {
      throw new ProfileImageValidationError("The JPEG image is incomplete.");
    }
    cursor = nextMarkerOffset;
  }

  throw new ProfileImageValidationError("The JPEG image is incomplete.");
}

function inspectWebp(bytes: Uint8Array): ProfileImageInfo {
  if (
    bytes.length < 20 ||
    ascii(bytes, 0, 4) !== "RIFF" ||
    ascii(bytes, 8, 4) !== "WEBP" ||
    readUint32LittleEndian(bytes, 4) + 8 !== bytes.length
  ) {
    throw new ProfileImageValidationError(
      "The upload is not a valid WebP image.",
    );
  }

  let cursor = 12;
  let canvasWidth = 0;
  let canvasHeight = 0;
  let imageWidth = 0;
  let imageHeight = 0;
  let imageChunks = 0;
  let extendedChunks = 0;

  while (cursor < bytes.length) {
    if (cursor + 8 > bytes.length) {
      throw new ProfileImageValidationError("The WebP image is incomplete.");
    }
    const chunkType = ascii(bytes, cursor, 4);
    const chunkLength = readUint32LittleEndian(bytes, cursor + 4);
    const payloadOffset = cursor + 8;
    const paddedLength = chunkLength + (chunkLength % 2);
    if (payloadOffset + paddedLength > bytes.length) {
      throw new ProfileImageValidationError("The WebP image is incomplete.");
    }
    if (chunkLength % 2 === 1 && bytes[payloadOffset + chunkLength] !== 0) {
      throw new ProfileImageValidationError("The WebP padding is invalid.");
    }

    if (chunkType === "ANIM" || chunkType === "ANMF") {
      throw new ProfileImageValidationError(
        "Animated profile pictures are not allowed.",
      );
    }

    if (chunkType === "VP8X") {
      if (chunkLength !== 10 || extendedChunks > 0 || imageChunks > 0) {
        throw new ProfileImageValidationError("The WebP container is invalid.");
      }
      const flags = bytes[payloadOffset];
      if ((flags & 0x02) !== 0) {
        throw new ProfileImageValidationError(
          "Animated profile pictures are not allowed.",
        );
      }
      if ((flags & 0xc1) !== 0) {
        throw new ProfileImageValidationError(
          "The WebP feature flags are invalid.",
        );
      }
      extendedChunks += 1;
      canvasWidth = readUint24LittleEndian(bytes, payloadOffset + 4) + 1;
      canvasHeight = readUint24LittleEndian(bytes, payloadOffset + 7) + 1;
      assertSafeDimensions(canvasWidth, canvasHeight);
    } else if (chunkType === "VP8 ") {
      if (
        chunkLength < 10 ||
        bytes[payloadOffset + 3] !== 0x9d ||
        bytes[payloadOffset + 4] !== 0x01 ||
        bytes[payloadOffset + 5] !== 0x2a
      ) {
        throw new ProfileImageValidationError("The WebP frame is invalid.");
      }
      imageChunks += 1;
      imageWidth = readUint16LittleEndian(bytes, payloadOffset + 6) & 0x3fff;
      imageHeight = readUint16LittleEndian(bytes, payloadOffset + 8) & 0x3fff;
      assertSafeDimensions(imageWidth, imageHeight);
    } else if (chunkType === "VP8L") {
      if (chunkLength < 5 || bytes[payloadOffset] !== 0x2f) {
        throw new ProfileImageValidationError("The WebP frame is invalid.");
      }
      const dimensions = readUint32LittleEndian(bytes, payloadOffset + 1);
      imageChunks += 1;
      imageWidth = (dimensions & 0x3fff) + 1;
      imageHeight = ((dimensions >>> 14) & 0x3fff) + 1;
      assertSafeDimensions(imageWidth, imageHeight);
    }

    cursor = payloadOffset + paddedLength;
  }

  if (cursor !== bytes.length || imageChunks !== 1 || extendedChunks > 1) {
    throw new ProfileImageValidationError(
      "Multi-frame WebP uploads are not allowed.",
    );
  }
  if (
    extendedChunks === 1 &&
    (canvasWidth !== imageWidth || canvasHeight !== imageHeight)
  ) {
    throw new ProfileImageValidationError(
      "The WebP canvas does not match its frame.",
    );
  }

  return {
    contentType: "image/webp",
    width: extendedChunks === 1 ? canvasWidth : imageWidth,
    height: extendedChunks === 1 ? canvasHeight : imageHeight,
  };
}

export function inspectProfileImage(
  bytes: Uint8Array,
  declaredType: string,
): ProfileImageInfo {
  const contentType = declaredType.toLowerCase().split(";", 1)[0].trim();
  if (bytes.length < 1 || bytes.length > PROFILE_IMAGE_MAX_BYTES) {
    throw new ProfileImageValidationError(
      "Profile pictures must be between 1 byte and 150 KB.",
    );
  }
  if (contentType === "image/jpeg") return inspectJpeg(bytes);
  if (contentType === "image/webp") return inspectWebp(bytes);
  throw new ProfileImageValidationError(
    "Choose a JPEG or WebP profile picture.",
  );
}

export async function sha256Hex(bytes: Uint8Array) {
  // Web Crypto intentionally rejects a SharedArrayBuffer-backed view. Copying
  // also prevents a caller from mutating the bytes while the digest is queued.
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", owned.buffer),
  );
  return Array.from(digest, (value) => value.toString(16).padStart(2, "0"))
    .join("");
}

const hardenedPolicy: IConfigurationFile = {
  fileName: "policy.xml",
  data: `<?xml version="1.0" encoding="UTF-8"?>
<policymap>
  <policy domain="resource" name="memory" value="32MiB" />
  <policy domain="resource" name="map" value="32MiB" />
  <policy domain="resource" name="disk" value="0B" />
  <policy domain="resource" name="width" value="256" />
  <policy domain="resource" name="height" value="256" />
  <policy domain="resource" name="area" value="65536" />
  <!-- ImageMagick reserves one internal list node while decoding. A value of
       two still lets the callback reject every multi-frame input. -->
  <policy domain="resource" name="list-length" value="2" />
  <policy domain="resource" name="thread" value="1" />
  <policy domain="resource" name="time" value="5" />
  <policy domain="delegate" rights="none" pattern="*" />
  <policy domain="filter" rights="none" pattern="*" />
  <policy domain="module" rights="none" pattern="*" />
  <policy domain="module" rights="read | write" pattern="{JPEG,WEBP}" />
  <policy domain="path" rights="none" pattern="@*" />
  <policy domain="path" rights="none" pattern="|*" />
  <policy domain="system" name="memory-map" value="anonymous" />
  <policy domain="system" name="max-memory-request" value="16MiB" />
</policymap>`,
};

const hardenedConfiguration: IConfigurationFiles = {
  log: ConfigurationFiles.default.log,
  policy: hardenedPolicy,
  *all() {
    yield this.log;
    yield this.policy;
  },
};

let magickReady: Promise<void> | null = null;

function ensureImageMagick() {
  if (!magickReady) {
    magickReady = (async () => {
      const moduleUrl = import.meta.resolve(
        "npm:@imagemagick/magick-wasm@0.0.41",
      );
      const wasmBytes = await Deno.readFile(new URL("magick.wasm", moduleUrl));
      await initializeImageMagick(wasmBytes, hardenedConfiguration);
    })();
  }
  return magickReady;
}

export async function reencodeProfileThumbnail(
  bytes: Uint8Array,
  declaredType: string,
): Promise<EncodedProfileImage> {
  const parsed = inspectProfileImage(bytes, declaredType);
  await ensureImageMagick();

  const sourceFormat = parsed.contentType === "image/jpeg"
    ? MagickFormat.Jpeg
    : MagickFormat.WebP;
  let output: Uint8Array | null = null;
  let width = 0;
  let height = 0;

  try {
    ImageMagick.readCollection(bytes, sourceFormat, (images) => {
      if (images.length !== 1) {
        throw new ProfileImageValidationError(
          "Animated or multi-frame profile pictures are not allowed.",
        );
      }
      const image = images[0];
      if (!image || image.format !== sourceFormat) {
        throw new ProfileImageValidationError("The image format is invalid.");
      }

      width = image.width;
      height = image.height;
      assertSafeDimensions(width, height);
      if (width !== parsed.width || height !== parsed.height) {
        throw new ProfileImageValidationError(
          "The decoded image dimensions do not match its header.",
        );
      }

      image.autoOrient();
      image.resetPage();
      image.strip();
      width = image.width;
      height = image.height;
      assertSafeDimensions(width, height);

      const cropSize = Math.min(width, height);
      image.crop(cropSize, cropSize, Gravity.Center);
      image.resetPage();
      if (cropSize > PROFILE_IMAGE_MAX_DIMENSION) {
        image.resize(
          PROFILE_IMAGE_MAX_DIMENSION,
          PROFILE_IMAGE_MAX_DIMENSION,
        );
      }
      width = image.width;
      height = image.height;
      assertSafeDimensions(width, height);
      if (width !== height) {
        throw new Error("The trusted profile-picture crop was not square.");
      }

      for (const quality of [82, 72, 60, 48, 36]) {
        image.quality = quality;
        const candidate = image.write(
          MagickFormat.WebP,
          (data) => new Uint8Array(data),
        );
        if (
          candidate.length > 0 && candidate.length <= PROFILE_IMAGE_MAX_BYTES
        ) {
          output = candidate;
          break;
        }
      }
    });
  } catch (error) {
    if (error instanceof ProfileImageValidationError) throw error;
    throw new ProfileImageValidationError(
      "We could not safely decode that profile picture.",
    );
  }

  if (!output) {
    throw new ProfileImageValidationError(
      "We could not compress that profile picture below 150 KB.",
    );
  }

  const encoded = output as Uint8Array;
  const verified = inspectProfileImage(encoded, "image/webp");
  if (verified.width !== width || verified.height !== height) {
    throw new Error(
      "The profile-picture encoder returned mismatched dimensions.",
    );
  }
  ImageMagick.readCollection(encoded, MagickFormat.WebP, (images) => {
    if (images.length !== 1) {
      throw new Error("The profile-picture encoder returned multiple frames.");
    }
    const image = images[0];
    const allowedEncoderAttributes = new Set([
      "date:create",
      "date:modify",
      "date:timestamp",
    ]);
    if (
      !image || image.profileNames.length !== 0 ||
      image.attributeNames.some((name) =>
        !allowedEncoderAttributes.has(name)
      ) ||
      image.comment !== null
    ) {
      throw new Error("The profile-picture encoder retained source metadata.");
    }
  });
  return {
    bytes: encoded,
    contentType: "image/webp",
    width,
    height,
    sha256: await sha256Hex(encoded),
  };
}
