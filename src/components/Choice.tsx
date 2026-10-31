/** Multiple-choice options with reveal state. */
export function Choices({
  options,
  answer,
  picked,
  onPick,
}: {
  options: string[];
  answer: number;
  picked: number | null;
  onPick: (i: number) => void;
}) {
  return (
    <div className="choices">
      {options.map((o, i) => {
        let cls = "choice";
        if (picked !== null) {
          if (i === answer) cls += " right";
          else if (i === picked) cls += " wrong";
        }
        return (
          <button key={i} className={cls} disabled={picked !== null} onClick={() => onPick(i)}>
            {o}
          </button>
        );
      })}
    </div>
  );
}
