import { assert, assertEquals } from "./test_helpers.ts";
import {
  inspectProfileImage,
  PROFILE_IMAGE_MAX_BYTES,
  ProfileImageValidationError,
  reencodeProfileThumbnail,
  sha256Hex,
} from "./profile_image.ts";

const decodedJpegFixture = Uint8Array.from(
  atob(
    "/9j/4AAQSkZJRgABAQAASABIAAD/4QCMRXhpZgAATU0AKgAAAAgABQESAAMAAAABAAEAAAEaAAUAAAABAAAASgEbAAUAAAABAAAAUgEoAAMAAAABAAIAAIdpAAQAAAABAAAAWgAAAAAAAABIAAAAAQAAAEgAAAABAAOgAQADAAAAAQABAACgAgAEAAAAAQAAACCgAwAEAAAAAQAAABgAAAAA/8AAEQgAGAAgAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwUDAwMFBgUFBQUGCAYGBgYGCAoICAgICAgKCgoKCgoKCgwMDAwMDA4ODg4ODw8PDw8PDw8PD//bAEMBAgICBAQEBwQEBxALCQsQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEP/dAAQAAv/aAAwDAQACEQMRAD8A88+L/wDwVy+K+NajJZfBnQLHwtpedsdxqEYv75/9orkQR/7oV/8AerhvC37QH/BQjx/4cb4maD8SCsErvDBYvFawtcbZFjZ4bc23lsgdtpkzhSGBI2tXkn7U37L/AIf+HP7VFp8BvhTPP9ku7Cymjm1ObzSjzRvJPLK6RjCKqFjtQ4A4BPFeu6bHo+h/Dqx0u41fTmtNMjhtkNzqa/aIpmUoxWB1YRjfJ5+ZR5flOoMe9XDaOwHNeOv2lf26PhIF8Ua98VWvTcXstj9nEUE8BkgG5ysclsseANu4J8ylgrhWyB6V8J/+CtfxH0i/hsfjV4ds/Eemv9+60tPsV7GP73lljDJ9P3f1rzT4yeHvCfi7RC+r+IdN06ytLJLmO5UC/lFukhlkeBspKizyMUi3bw4MaBgdwHlf7DvwD+Hf7Rfxp1XwV43+2rolppdzew+RMIbjKSxpHuYKy5w/zADGelID/9Dwr/gpR8Nfix42/al1DWfCPg7WdX09dI02Fbmx0+4nhcrGxcCSJGUkFsHnjoa/Px/gH8dF+Zvhx4iX/uE3f/xqv6rPHP8AyMz/APXun9a87vv9UPqKsD+ZT/hQ/wAdmAA+HfiIj/sE3f8A8b9a/Qv/AIJofD74meAv2h7u/wDGPhLV9DsrvQryAT3thcW8XmeZC6rvkRVyQpwO9fqnD/DXV+Ff+Rki/wCuT/yosB//2Q==",
  ),
  (character) => character.charCodeAt(0),
);

function webpChunk(name: string, payload: number[]) {
  const padded = payload.length + (payload.length % 2);
  const bytes = new Uint8Array(8 + padded);
  bytes.set(new TextEncoder().encode(name), 0);
  new DataView(bytes.buffer).setUint32(4, payload.length, true);
  bytes.set(payload, 8);
  return bytes;
}

function webp(chunks: Uint8Array[]) {
  const length = 12 + chunks.reduce((total, chunk) => total + chunk.length, 0);
  const bytes = new Uint8Array(length);
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  new DataView(bytes.buffer).setUint32(4, length - 8, true);
  bytes.set(new TextEncoder().encode("WEBP"), 8);
  let offset = 12;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

function lossyFrame(width: number, height: number) {
  return webpChunk("VP8 ", [
    0,
    0,
    0,
    0x9d,
    0x01,
    0x2a,
    width & 0xff,
    (width >>> 8) & 0x3f,
    height & 0xff,
    (height >>> 8) & 0x3f,
  ]);
}

function jpeg(width: number, height: number, extra: number[] = []) {
  return new Uint8Array([
    0xff,
    0xd8,
    ...extra,
    0xff,
    0xc0,
    0x00,
    0x0b,
    0x08,
    (height >>> 8) & 0xff,
    height & 0xff,
    (width >>> 8) & 0xff,
    width & 0xff,
    0x01,
    0x01,
    0x11,
    0x00,
    0xff,
    0xda,
    0x00,
    0x08,
    0x01,
    0x01,
    0x00,
    0x00,
    0x3f,
    0x00,
    0x00,
    0xff,
    0xd9,
  ]);
}

Deno.test("profile-image headers accept only bounded single-frame JPEG and WebP", () => {
  assertEquals(inspectProfileImage(jpeg(256, 128), "image/jpeg"), {
    contentType: "image/jpeg",
    width: 256,
    height: 128,
  });
  assertEquals(inspectProfileImage(webp([lossyFrame(80, 120)]), "image/webp"), {
    contentType: "image/webp",
    width: 80,
    height: 120,
  });
});

Deno.test("profile-image headers reject mismatched MIME, oversized pixels, and trailing bytes", () => {
  for (
    const [bytes, contentType] of [
      [jpeg(32, 32), "image/webp"],
      [webp([lossyFrame(32, 32)]), "image/jpeg"],
      [jpeg(257, 10), "image/jpeg"],
      [webp([lossyFrame(256, 257)]), "image/webp"],
      [new Uint8Array(PROFILE_IMAGE_MAX_BYTES + 1), "image/jpeg"],
    ] as const
  ) {
    let rejected = false;
    try {
      inspectProfileImage(bytes, contentType);
    } catch (error) {
      rejected = error instanceof ProfileImageValidationError;
    }
    assert(rejected);
  }

  const valid = webp([lossyFrame(32, 32)]);
  const trailing = new Uint8Array(valid.length + 1);
  trailing.set(valid);
  let rejected = false;
  try {
    inspectProfileImage(trailing, "image/webp");
  } catch (error) {
    rejected = error instanceof ProfileImageValidationError;
  }
  assert(rejected);
});

Deno.test("profile-image headers reject animation, multiple frames, and MPO JPEG", () => {
  const animatedHeader = webpChunk("VP8X", [
    0x02,
    0,
    0,
    0,
    31,
    0,
    0,
    31,
    0,
    0,
  ]);
  const inputs = [
    webp([animatedHeader, lossyFrame(32, 32)]),
    webp([lossyFrame(32, 32), lossyFrame(32, 32)]),
    jpeg(32, 32, [0xff, 0xe2, 0x00, 0x06, 0x4d, 0x50, 0x46, 0x00]),
  ];
  for (const bytes of inputs) {
    let rejected = false;
    try {
      inspectProfileImage(
        bytes,
        bytes[0] === 0xff ? "image/jpeg" : "image/webp",
      );
    } catch (error) {
      rejected = error instanceof ProfileImageValidationError &&
        /animated|multi/i.test(error.message);
    }
    assert(rejected);
  }
});

Deno.test("profile-image checksums are stable lower-case SHA-256", async () => {
  assertEquals(
    await sha256Hex(new TextEncoder().encode("dominion")),
    "ad589ceb8b5ccca048911a0e4dcf5466a1f14dc9f50517c9a2c53988d7de2521",
  );
});

Deno.test("profile-image transformer center-crops rectangular JPEG and emits verified square WebP", async () => {
  const encoded = await reencodeProfileThumbnail(
    decodedJpegFixture,
    "image/jpeg",
  );
  assertEquals(encoded.contentType, "image/webp");
  assertEquals(encoded.width, 24);
  assertEquals(encoded.height, 24);
  assert(encoded.bytes.byteLength > 0);
  assert(encoded.bytes.byteLength <= PROFILE_IMAGE_MAX_BYTES);
  assertEquals(
    inspectProfileImage(encoded.bytes, encoded.contentType),
    { contentType: "image/webp", width: 24, height: 24 },
  );
  assertEquals(encoded.sha256, await sha256Hex(encoded.bytes));
  assertEquals(
    new TextDecoder().decode(encoded.bytes.subarray(0, 4)),
    "RIFF",
  );

  const reencoded = await reencodeProfileThumbnail(
    encoded.bytes,
    "image/webp",
  );
  assertEquals(
    inspectProfileImage(reencoded.bytes, reencoded.contentType),
    { contentType: "image/webp", width: 24, height: 24 },
  );
  assertEquals(reencoded.sha256, await sha256Hex(reencoded.bytes));
});
