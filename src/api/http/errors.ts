export type ApiErrorCode = "MEETING_NOT_FOUND" | "INTERNAL_ERROR" | "NOT_FOUND";

export type ApiErrorBody = {
  error: {
    code: ApiErrorCode;
    message: string;
  };
};

export function apiError(code: ApiErrorCode, message: string): ApiErrorBody {
  return {
    error: {
      code,
      message,
    },
  };
}

export const meetingNotFound = (): ApiErrorBody =>
  apiError("MEETING_NOT_FOUND", "Meeting not found.");

export const internalError = (): ApiErrorBody =>
  apiError("INTERNAL_ERROR", "Internal server error.");

export const routeNotFound = (): ApiErrorBody =>
  apiError("NOT_FOUND", "Route not found.");
