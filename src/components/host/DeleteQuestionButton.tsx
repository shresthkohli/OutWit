import React, { useState } from 'react';
import { Trash2, Check, X } from 'lucide-react';

export interface DeleteQuestionButtonProps {
  roundNumber: number;
  onConfirm: (roundNumber: number) => Promise<void>;
  disabled?: boolean;
}

export const DeleteQuestionButton: React.FC<DeleteQuestionButtonProps> = ({
  roundNumber,
  onConfirm,
  disabled = false,
}) => {
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);

  const handleConfirm = async () => {
    setSaving(true);
    try {
      await onConfirm(roundNumber);
    } finally {
      setSaving(false);
      setConfirming(false);
    }
  };

  if (confirming) {
    return (
      <div className="flex items-center gap-1">
        <button
          type="button"
          disabled={disabled || saving}
          onClick={handleConfirm}
          className="p-1 text-outwit-red hover:text-red-400 disabled:opacity-40 transition-colors"
          title="Confirm delete"
          aria-label="Confirm delete"
        >
          <Check className="w-4 h-4" />
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={() => setConfirming(false)}
          className="p-1 text-neutral-400 hover:text-white disabled:opacity-40 transition-colors"
          title="Cancel"
          aria-label="Cancel"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => setConfirming(true)}
      className="p-1 text-neutral-400 hover:text-outwit-red transition-colors disabled:opacity-40"
      title="Delete question"
      aria-label={`Delete question for round ${roundNumber}`}
    >
      <Trash2 className="w-4 h-4" />
    </button>
  );
};
