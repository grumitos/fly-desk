import { clsx, type ClassValue } from "clsx"

/* Joins class names. Component base styles live in `@layer components`, so a
   utility passed by a caller always wins without a merge step. */
export function cn(...inputs: ClassValue[]) {
  return clsx(inputs)
}
