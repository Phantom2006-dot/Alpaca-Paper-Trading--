import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { AlertTriangle, X, Check, RefreshCw } from 'lucide-react';

function cx(...c: Array<string | false | null | undefined>) {
  return c.filter(Boolean).join(' ');
}

type Props = {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  pending: boolean;
};

export function KillSwitchModal({ open, onClose, onConfirm, pending }: Props) {
  const [typed, setTyped] = useState('');
  const canConfirm = typed.trim().toUpperCase() === 'HALT';

  function handleConfirm() {
    if (!canConfirm || pending) return;
    onConfirm();
    setTyped('');
  }

  function handleClose() {
    setTyped('');
    onClose();
  }

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            className="kill-scrim"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={handleClose}
          />
          <motion.div
            className="kill-modal"
            initial={{ opacity: 0, scale: 0.94, y: 16 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.94, y: 16 }}
            transition={{ duration: 0.2 }}
            role="dialog"
            aria-modal="true"
            aria-label="Kill switch confirmation"
          >
            <div className="kill-modal-header">
              <div className="kill-modal-icon">
                <AlertTriangle size={22} />
              </div>
              <div>
                <div className="kill-modal-title">Emergency Kill Switch</div>
                <div className="kill-modal-sub">This will flatten all paper positions and stop the agent.</div>
              </div>
              <button className="icon-button ml-auto" onClick={handleClose} aria-label="Close">
                <X size={15} />
              </button>
            </div>

            <div className="kill-modal-body">
              <div className="kill-modal-steps">
                {[
                  'Cancel all pending paper orders',
                  'Market-sell all open paper positions',
                  'Disarm the continuous automation loop',
                  'Lock all execution controls',
                ].map((step, i) => (
                  <div key={step} className="kill-modal-step">
                    <span className="kill-modal-step-n">{String(i + 1).padStart(2, '0')}</span>
                    <span>{step}</span>
                  </div>
                ))}
              </div>

              <div className="kill-modal-confirm-field">
                <label className="kill-modal-confirm-label">
                  Type <strong>HALT</strong> to confirm
                </label>
                <input
                  className={cx('kill-modal-input', canConfirm && 'is-ready')}
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  placeholder="HALT"
                  autoFocus
                  onKeyDown={(e) => e.key === 'Enter' && handleConfirm()}
                />
              </div>
            </div>

            <div className="kill-modal-footer">
              <button className="button button-secondary" onClick={handleClose} disabled={pending}>
                Cancel
              </button>
              <button
                className={cx('button kill-confirm-btn', canConfirm && 'is-ready')}
                onClick={handleConfirm}
                disabled={!canConfirm || pending}
              >
                {pending
                  ? <><RefreshCw size={13} className="animate-spin" /> Flattening…</>
                  : <><Check size={13} /> CONFIRM FLATTEN</>}
              </button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
