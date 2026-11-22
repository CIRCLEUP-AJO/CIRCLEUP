import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAnnouncer } from '../hooks/useAnnouncer';

export type CopyStatus = 'idle' | 'copied' | 'unavailable' | 'failed';

export interface UseCopyToClipboardResult {
  status: CopyStatus;
  copy: (text: string) => Promise<boolean>;
  reset: () => void;
}

/**
 * Reusable hook that wraps the clipboard API with secure-context detection,
 * awaited writeText, and explicit success/failure status reporting.
 */
export function useCopyToClipboard(): UseCopyToClipboardResult {
  const [status, setStatus] = useState<CopyStatus>('idle');

  const reset = useCallback(() => {
    setStatus('idle');
  }, []);

  const copy = useCallback(async (text: string): Promise<boolean> => {
    const clipboardAvailable =
      typeof navigator !== 'undefined' &&
      typeof navigator.clipboard !== 'undefined' &&
      typeof navigator.clipboard.writeText === 'function';

    const secureContext =
      typeof window === 'undefined' ? true : window.isSecureContext !== false;

    if (!clipboardAvailable || !secureContext) {
      setStatus('unavailable');
      return false;
    }

    try {
      await navigator.clipboard.writeText(text);
      setStatus('copied');
      return true;
    } catch {
      setStatus('failed');
      return false;
    }
  }, []);

  return { status, copy, reset };
}

export interface CopyControlProps {
  /** The text to copy. Should be the exact value the user expects to copy. */
  value: string;
  /** Optional accessible label describing what is being copied. */
  label?: string;
  /** Optional visible button text. Defaults to "Copy". */
  buttonText?: string;
  /** Optional className applied to the wrapper. */
  className?: string;
  /** Optional callback invoked with the resulting status. */
  onStatusChange?: (status: CopyStatus) => void;
}

const statusMessages: Record<CopyStatus, string> = {
  idle: '',
  copied: 'Copied to clipboard',
  unavailable: 'Clipboard unavailable. Select the text to copy manually.',
  failed: 'Copy failed. Select the text to copy manually.',
};

/**
 * Accessible copy control with a manual-selection fallback.
 *
 * - Detects secure context and clipboard availability.
 * - Only announces success after clipboard.writeText resolves.
 * - On failure/unavailability, renders a readonly, selectable input that is
 *   focused and selected so the user can copy manually.
 * - Announces status changes via useAnnouncer and an aria-live region.
 */
const CopyControl: React.FC<CopyControlProps> = ({
  value,
  label,
  buttonText = 'Copy',
  className,
  onStatusChange,
}) => {
  const { status, copy, reset } = useCopyToClipboard();
  const fallbackRef = useRef<HTMLInputElement>(null);
  const announce = useAnnouncer();

  const showFallback = status === 'unavailable' || status === 'failed';

  useEffect(() => {
    const message = statusMessages[status];
    if (message) {
      announce(message);
    }
    if (onStatusChange) {
      onStatusChange(status);
    }
  }, [status, announce, onStatusChange]);

  useEffect(() => {
    if (showFallback && fallbackRef.current) {
      const input = fallbackRef.current;
      input.focus();
      try {
        input.select();
      } catch {
        // Selection may be unsupported; focus alone still allows manual copy.
      }
    }
  }, [showFallback]);

  const handleCopy = useCallback(async () => {
    // Reset first so repeated attempts re-announce the same outcome.
    reset();
    await copy(value);
  }, [copy, reset, value]);

  const accessibleLabel = label ? `Copy ${label}` : 'Copy to clipboard';

  return (
    <div className={className} data-copy-status={status}>
      <button
        type="button"
        onClick={handleCopy}
        aria-label={accessibleLabel}
        aria-describedby={status !== 'idle' ? 'copy-control-status' : undefined}
      >
        {buttonText}
      </button>

      {showFallback && (
        <input
          ref={fallbackRef}
          type="text"
          readOnly
          value={value}
          aria-label={label ? `${label} (select to copy)` : 'Text to copy manually'}
          onFocus={(event) => {
            try {
              event.currentTarget.select();
            } catch {
              // Ignore selection errors; the value remains selectable.
            }
          }}
        />
      )}

      <span
        id="copy-control-status"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        style={{
          position: 'absolute',
          width: 1,
          height: 1,
          padding: 0,
          margin: -1,
          overflow: 'hidden',
          clip: 'rect(0, 0, 0, 0)',
          whiteSpace: 'nowrap',
          border: 0,
        }}
      >
        {statusMessages[status]}
      </span>
    </div>
  );
};

export default CopyControl;