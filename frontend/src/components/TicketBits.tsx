import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import QRCode from 'qrcode';

export function StatusBadge({ status }: { status: 'BOOKED' | 'CHECKED_IN' }) {
  return status === 'CHECKED_IN' ? (
    <span className="badge badge-neutral">
      <span aria-hidden="true">✓</span> Checked in
    </span>
  ) : (
    <span className="badge badge-good">
      <span aria-hidden="true">●</span> Ready to use
    </span>
  );
}

export interface QrHandle {
  /** PNG of the QR code as a Blob, for the Download button. */
  toBlob: () => Promise<Blob | null>;
}

// Draws the ticket's signed token as a QR code, entirely in the browser. White background and black
// squares on purpose: scanners read that best, also in dark mode.
export const QrCanvas = forwardRef<QrHandle, { value: string }>(function QrCanvas({ value }, ref) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);

  useImperativeHandle(ref, () => ({
    toBlob: () => new Promise((resolve) => (canvas.current ? canvas.current.toBlob(resolve, 'image/png') : resolve(null))),
  }));

  useEffect(() => {
    if (!canvas.current) return;
    setFailed(false);
    QRCode.toCanvas(canvas.current, value, { width: 288, margin: 2, errorCorrectionLevel: 'M' }).catch(() => setFailed(true));
  }, [value]);

  if (failed) return <p role="alert">We couldn't draw the QR code. Use the ticket code below instead.</p>;
  return <canvas ref={canvas} className="qr" role="img" aria-label="QR code for your ticket" />;
});
