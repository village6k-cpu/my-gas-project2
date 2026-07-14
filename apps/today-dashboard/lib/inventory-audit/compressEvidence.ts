"use client";

export const INVENTORY_AUDIT_COMPRESSION_PROFILES = [
  { maxDimension: 1_600, quality: 0.82 },
  { maxDimension: 1_280, quality: 0.78 },
  { maxDimension: 1_024, quality: 0.72 },
] as const;
export const INVENTORY_AUDIT_COMPRESSED_MAX_BYTES = 3_500_000;

export class InventoryAuditImageError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InventoryAuditImageError";
    this.code = code;
  }
}

type DecodedImage = {
  source: CanvasImageSource;
  width: number;
  height: number;
  close(): void;
};

async function decodeImage(file: File): Promise<DecodedImage> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file, {
        imageOrientation: "from-image",
      });
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        close: () => bitmap.close(),
      };
    } catch (error) {
      throw new InventoryAuditImageError(
        "evidence_decode_failed",
        "사진을 읽지 못했습니다. 다른 사진으로 다시 시도해 주세요.",
        { cause: error instanceof Error ? error : undefined },
      );
    }
  }
  if (
    typeof document === "undefined" ||
    typeof Image === "undefined" ||
    typeof URL === "undefined"
  ) {
    throw new InventoryAuditImageError(
      "evidence_decode_unavailable",
      "이 브라우저에서는 사진을 처리할 수 없습니다.",
    );
  }
  const objectUrl = URL.createObjectURL(file);
  const image = new Image();
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("image decode failed"));
      image.src = objectUrl;
    });
    return {
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      close: () => URL.revokeObjectURL(objectUrl),
    };
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw new InventoryAuditImageError(
      "evidence_decode_failed",
      "사진을 읽지 못했습니다. 다른 사진으로 다시 시도해 주세요.",
      { cause: error instanceof Error ? error : undefined },
    );
  }
}

function canvasToJpeg(
  canvas: HTMLCanvasElement,
  quality: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob || blob.type !== "image/jpeg") {
          reject(
            new InventoryAuditImageError(
              "evidence_compression_failed",
              "사진을 JPEG로 변환하지 못했습니다.",
            ),
          );
          return;
        }
        resolve(blob);
      },
      "image/jpeg",
      quality,
    );
  });
}

export async function compressInventoryAuditEvidence(file: File): Promise<Blob> {
  if (!(file instanceof File) || !file.type.startsWith("image/")) {
    throw new InventoryAuditImageError(
      "invalid_evidence_file",
      "사진 파일을 선택해 주세요.",
    );
  }
  if (typeof document === "undefined") {
    throw new InventoryAuditImageError(
      "evidence_compression_unavailable",
      "이 브라우저에서는 사진을 압축할 수 없습니다.",
    );
  }
  const decoded = await decodeImage(file);
  try {
    if (decoded.width <= 0 || decoded.height <= 0) {
      throw new InventoryAuditImageError(
        "evidence_decode_failed",
        "사진 크기를 확인하지 못했습니다.",
      );
    }
    for (const profile of INVENTORY_AUDIT_COMPRESSION_PROFILES) {
      const ratio = Math.min(
        1,
        profile.maxDimension / Math.max(decoded.width, decoded.height),
      );
      const width = Math.max(1, Math.round(decoded.width * ratio));
      const height = Math.max(1, Math.round(decoded.height * ratio));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) {
        throw new InventoryAuditImageError(
          "evidence_compression_unavailable",
          "사진 압축 화면을 만들지 못했습니다.",
        );
      }
      context.fillStyle = "#fff";
      context.fillRect(0, 0, width, height);
      context.drawImage(decoded.source, 0, 0, width, height);
      const jpeg = await canvasToJpeg(canvas, profile.quality);
      canvas.width = 1;
      canvas.height = 1;
      if (jpeg.size <= INVENTORY_AUDIT_COMPRESSED_MAX_BYTES) return jpeg;
    }
  } finally {
    decoded.close();
  }
  throw new InventoryAuditImageError(
    "evidence_too_large_after_compression",
    "사진을 3.5MB 이하로 줄이지 못했습니다. 다른 사진으로 다시 시도해 주세요.",
  );
}
