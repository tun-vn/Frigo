import React, { useEffect, useRef, useState } from 'react';
import { Camera, RefreshCw, Zap, ZapOff, Image as ImageIcon } from 'lucide-react';
import { clsx } from 'clsx';
import { PRIVATE_IMAGE_JPEG_QUALITY, PRIVATE_IMAGE_MAX_DIMENSION } from '../../lib/private-image';

interface CameraViewfinderProps {
  onCapture: (base64: string) => void;
  onSelectFromGallery: () => void;
  scanType: 'fridge' | 'food' | 'receipt';
}

export const CameraViewfinder: React.FC<CameraViewfinderProps> = ({
  onCapture,
  onSelectFromGallery,
  scanType,
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [facingMode, setFacingMode] = useState<'environment' | 'user'>('environment');
  const [isTorchOn, setIsTorchOn] = useState(false);
  const [hasTorchSupport, setHasTorchSupport] = useState(false);
  const [hasCameraError, setHasCameraError] = useState(false);
  const [isStartingCamera, setIsStartingCamera] = useState(true);

  // Initialize camera stream
  useEffect(() => {
    let active = true;

    async function startCamera() {
      setIsStartingCamera(true);
      setHasCameraError(false);

      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
      }

      try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          throw new Error('Camera not supported');
        }

        const mediaStream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: facingMode },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        });

        if (!active) {
          mediaStream.getTracks().forEach((t) => t.stop());
          return;
        }

        setStream(mediaStream);
        if (videoRef.current) {
          videoRef.current.srcObject = mediaStream;
        }

        // Check torch support
        const track = mediaStream.getVideoTracks()[0];
        const capabilities: any = track.getCapabilities ? track.getCapabilities() : {};
        if (capabilities.torch) {
          setHasTorchSupport(true);
        } else {
          setHasTorchSupport(false);
        }
      } catch (err) {
        console.warn('Camera access could not be established:', err);
        if (active) {
          setHasCameraError(true);
        }
      } finally {
        if (active) {
          setIsStartingCamera(false);
        }
      }
    }

    startCamera();

    return () => {
      active = false;
      if (stream) {
        stream.getTracks().forEach((t) => t.stop());
      }
    };
  }, [facingMode]);

  // Handle capture
  const handleCapture = () => {
    if (videoRef.current && videoRef.current.videoWidth > 0) {
      const canvas = document.createElement('canvas');
      const sourceWidth = videoRef.current.videoWidth;
      const sourceHeight = videoRef.current.videoHeight;
      const scale = Math.min(1, PRIVATE_IMAGE_MAX_DIMENSION / Math.max(sourceWidth, sourceHeight));
      canvas.width = Math.max(1, Math.round(sourceWidth * scale));
      canvas.height = Math.max(1, Math.round(sourceHeight * scale));
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL('image/jpeg', PRIVATE_IMAGE_JPEG_QUALITY);
        onCapture(dataUrl);
        return;
      }
    }
    // If camera not ready, trigger gallery fallback
    onSelectFromGallery();
  };

  const toggleTorch = async () => {
    if (!stream || !hasTorchSupport) return;
    const track = stream.getVideoTracks()[0];
    try {
      await (track as any).applyConstraints({
        advanced: [{ torch: !isTorchOn }],
      });
      setIsTorchOn(!isTorchOn);
    } catch {
      // Ignore
    }
  };

  const switchCamera = () => {
    setFacingMode((prev) => (prev === 'environment' ? 'user' : 'environment'));
  };

  return (
    <div className="relative w-full h-[360px] sm:h-[420px] rounded-2xl overflow-hidden bg-slate-950 flex items-center justify-center border border-white/15 shadow-2xl">
      {/* Video stream */}
      {!hasCameraError && (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className={clsx(
            'w-full h-full object-cover transition-opacity duration-300',
            isStartingCamera ? 'opacity-0' : 'opacity-100'
          )}
        />
      )}

      {/* Fallback Viewfinder if camera blocked/unavailable */}
      {(hasCameraError || isStartingCamera) && (
        <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center space-y-3 bg-slate-950/90 backdrop-blur-sm">
          <div className="w-14 h-14 rounded-2xl bg-white/10 border border-white/15 flex items-center justify-center text-white/80">
            <Camera className="w-7 h-7 text-emerald-400" />
          </div>
          <div>
            <p className="font-heading font-bold text-sm text-white">
              {hasCameraError ? 'Camera không sẵn sàng' : 'Đang bật camera...'}
            </p>
            <p className="text-xs text-slate-300 mt-1 max-w-xs leading-relaxed">
              {hasCameraError
                ? 'Bạn có thể chọn ảnh từ thư viện để tiếp tục'
                : 'Vui lòng cấp quyền truy cập camera nếu được hỏi'}
            </p>
          </div>
          {hasCameraError && (
            <button
              onClick={onSelectFromGallery}
              className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs flex items-center gap-1.5 shadow-sm tap-target transition-all active:scale-[0.98]"
            >
              <ImageIcon className="w-4 h-4" />
              <span>Tải ảnh từ thư viện</span>
            </button>
          )}
        </div>
      )}

      {/* Viewfinder Guide Overlay */}
      <div className="absolute inset-3.5 pointer-events-none flex flex-col justify-between">
        {/* Top Controls */}
        <div className="flex items-center justify-between pointer-events-auto">
          {hasTorchSupport ? (
            <button
              onClick={toggleTorch}
              className={clsx(
                'w-10 h-10 rounded-xl flex items-center justify-center backdrop-blur-md transition-all tap-target border border-white/10',
                isTorchOn ? 'bg-amber-400 text-slate-900' : 'bg-slate-900/60 text-white'
              )}
              aria-label="Đèn pin"
            >
              {isTorchOn ? <Zap className="w-4 h-4 fill-current" /> : <ZapOff className="w-4 h-4" />}
            </button>
          ) : (
            <div className="w-10" />
          )}

          <div className="px-3.5 py-1.5 rounded-full bg-slate-900/75 backdrop-blur-md text-[11px] font-heading font-semibold text-white border border-white/15 shadow-md">
            {scanType === 'receipt'
              ? 'Căn chỉnh toàn bộ hóa đơn vào khung'
              : scanType === 'fridge'
              ? 'Hướng vào tủ lạnh để nhận diện thực phẩm'
              : 'Đặt thực phẩm vào giữa khung hình'}
          </div>

          <button
            onClick={switchCamera}
            className="w-10 h-10 rounded-xl bg-slate-900/60 backdrop-blur-md text-white border border-white/10 flex items-center justify-center tap-target hover:bg-slate-800/80 transition-all"
            aria-label="Đổi camera"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>

        {/* Viewfinder Target Frame */}
        <div className="relative flex-1 my-3 flex items-center justify-center">
          <div
            className={clsx(
              'border border-white/30 transition-all duration-300 relative overflow-hidden',
              scanType === 'receipt'
                ? 'w-4/5 h-[90%] rounded-xl'
                : 'w-[85%] h-[85%] rounded-2xl'
            )}
          >
            {/* 4 Corner Markers */}
            <div className="absolute top-0 left-0 w-4 h-4 border-t-2 border-l-2 border-emerald-400 rounded-tl-sm" />
            <div className="absolute top-0 right-0 w-4 h-4 border-t-2 border-r-2 border-emerald-400 rounded-tr-sm" />
            <div className="absolute bottom-0 left-0 w-4 h-4 border-b-2 border-l-2 border-emerald-400 rounded-bl-sm" />
            <div className="absolute bottom-0 right-0 w-4 h-4 border-b-2 border-r-2 border-emerald-400 rounded-br-sm" />

            {/* Scanning Laser Line */}
            <div className="w-full h-0.5 bg-gradient-to-r from-transparent via-emerald-400 to-transparent shadow-[0_0_8px_#34d399] animate-[scanLaser_2.5s_ease-in-out_infinite]" />
          </div>
        </div>

        {/* Bottom Shutter Trigger Bar */}
        <div className="flex items-center justify-around pointer-events-auto pb-1">
          <button
            onClick={onSelectFromGallery}
            className="px-4 py-2.5 rounded-xl bg-slate-900/60 border border-white/15 backdrop-blur-md text-white flex items-center gap-2 tap-target hover:bg-slate-800 active:scale-95 transition-all"
            title="Thư viện"
            aria-label="Thư viện"
          >
            <ImageIcon className="w-5 h-5" />
            <span className="text-xs font-heading font-bold">Thư viện</span>
          </button>

          {/* Big Shutter Button */}
          <button
            onClick={handleCapture}
            className="w-20 h-20 rounded-full border-[3px] border-white/90 flex items-center justify-center bg-transparent active:scale-95 transition-transform p-1.5 tap-target shadow-[0_0_24px_rgba(52,211,153,0.35)]"
            aria-label="Chụp ảnh"
          >
            <div className="w-full h-full rounded-full bg-gradient-to-br from-white to-emerald-50 flex items-center justify-center shadow-md">
              <Camera className="w-8 h-8 text-slate-900 stroke-[2.2]" />
            </div>
          </button>

          <div className="w-11" />
        </div>
      </div>
    </div>
  );
};
