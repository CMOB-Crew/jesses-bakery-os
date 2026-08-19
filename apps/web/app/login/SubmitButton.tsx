"use client";

import { useFormStatus } from "react-dom";

// Submit button that reflects the parent <form>'s pending state. The moment the
// form is submitting, it disables and swaps to a spinner + pending label, so the
// sign-in never feels dead while the auth round-trip happens.
export default function SubmitButton({
  children,
  pendingText,
  className,
}: {
  children: React.ReactNode;
  pendingText: string;
  className?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={className} disabled={pending} aria-busy={pending}>
      {pending ? (
        <span className="loginbtn-loading">
          <span className="loginspin" aria-hidden="true" />
          {pendingText}
        </span>
      ) : (
        children
      )}
    </button>
  );
}
