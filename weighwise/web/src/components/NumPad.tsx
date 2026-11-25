interface Props {
  onDigit: (d: string) => void;
  onBackspace: () => void;
  onClear?: () => void;
}

// Large touch-friendly keypad used on the kiosk.
export function NumPad({ onDigit, onBackspace, onClear }: Props) {
  return (
    <div className="numpad" role="group" aria-label="מקלדת מספרים">
      {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
        <button key={d} type="button" onClick={() => onDigit(d)} aria-label={d}>
          {d}
        </button>
      ))}
      <button type="button" onClick={onClear ?? onBackspace} aria-label="נקה">
        C
      </button>
      <button type="button" onClick={() => onDigit('0')} aria-label="0">
        0
      </button>
      <button type="button" onClick={onBackspace} aria-label="מחק ספרה">
        ⌫
      </button>
    </div>
  );
}
