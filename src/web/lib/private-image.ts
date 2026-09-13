import { capturePrivateSession } from './private-session';

// Receipt text remains readable at this size while avoiding multi-megapixel uploads.
export const PRIVATE_IMAGE_MAX_DIMENSION = 2_000;
export const PRIVATE_IMAGE_JPEG_QUALITY = 0.82;

export function readPrivateImage(file: Blob, onLoad: (image: string) => void): () => void {
  const isCurrent = capturePrivateSession();
  let cancelled = false;

  let reader: FileReader | null = null;
  let bitmap: ImageBitmap | null = null;

  const readAsDataUrl = (blob: Blob) => {
    if (cancelled) return;
    reader = new FileReader();
    reader.onload = () => {
      if (!cancelled && isCurrent() && typeof reader?.result === 'string') onLoad(reader.result);
    };
    reader.readAsDataURL(blob);
  };

  const preprocess = async () => {
    if (typeof globalThis.createImageBitmap !== 'function' || typeof document === 'undefined') {
      readAsDataUrl(file);
      return;
    }

    try {
      bitmap = await globalThis.createImageBitmap(file);
      if (cancelled) return;

      const sourceWidth = bitmap.width;
      const sourceHeight = bitmap.height;
      const longestSide = Math.max(sourceWidth, sourceHeight);
      const scale = Math.min(1, PRIVATE_IMAGE_MAX_DIMENSION / longestSide);
      const width = Math.max(1, Math.round(sourceWidth * scale));
      const height = Math.max(1, Math.round(sourceHeight * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context || typeof canvas.toBlob !== 'function') {
        readAsDataUrl(file);
        return;
      }
      context.drawImage(bitmap, 0, 0, width, height);
      canvas.toBlob((compressed) => {
        if (cancelled) return;
        // Keep the dimension cap even when an unusual source compresses poorly.
        const resized = width !== sourceWidth || height !== sourceHeight;
        readAsDataUrl(compressed && (resized || compressed.size < file.size) ? compressed : file);
      }, 'image/jpeg', PRIVATE_IMAGE_JPEG_QUALITY);
    } catch {
      // Decoding/canvas support is optional; the original reader remains reliable.
      readAsDataUrl(file);
    } finally {
      bitmap?.close();
      bitmap = null;
    }
  };

  void preprocess();

  return () => {
    cancelled = true;
    if (reader) {
      reader.onload = null;
      if (reader.readyState === FileReader.LOADING) reader.abort();
    }
    bitmap?.close();
  };
}
