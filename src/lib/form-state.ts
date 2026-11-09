export type FormState = {
  ok?: boolean;
  message?: string;
  error?: string;
  fieldErrors?: Record<string, string>;
};

export type FormAction = (state: FormState, data: FormData) => Promise<FormState>;
