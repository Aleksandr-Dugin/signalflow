import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatMoney(cents: number, currency = "USD"): string {
  return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(cents / 100);
}

export function scoreColor(score: number): string {
  if (score >= 75) return "text-success";
  if (score >= 50) return "text-amber-500";
  return "text-muted-foreground";
}
