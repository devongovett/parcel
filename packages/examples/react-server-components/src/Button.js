'use client';
import './Button.css';

export default function Button({action, children}) {
  return (
    <button
      onClick={async () => {
        const result = await action();
        console.log(result);
      }}>
      {children}
    </button>
  );
}
