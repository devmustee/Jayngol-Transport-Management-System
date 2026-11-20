export type FormState = {
  ok?: boolean;
  message?: string;
  error?: string;
  fieldErrors?: Record<string, string>;
  /** A Guide topic that explains the refusal, shown as a link under it. */
  help?: { id: string; title: string };
};

export type FormAction = (state: FormState, data: FormData) => Promise<FormState>;
