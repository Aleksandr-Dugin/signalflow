import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { UNAUTHED_ERR_MSG } from "../../shared/const";
import type { Context } from "./context";

const t = initTRPC.context<Context>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    // The client matches on this exact message to trigger a redirect to /login.
    if (error.code === "UNAUTHORIZED") {
      return { ...shape, message: UNAUTHED_ERR_MSG };
    }
    return shape;
  },
});

export const createCallerFactory = t.createCallerFactory;
export const router = t.router;
export const publicProcedure = t.procedure;

export const middleware = t.middleware;

function requireAuth({ ctx }: { ctx: Context }) {
  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  return ctx.user;
}

export const protectedProcedure = t.procedure.use(function authed(opts) {
  const user = requireAuth(opts);
  return opts.next({ ctx: { ...opts.ctx, user } });
});

export const adminProcedure = t.procedure.use(function admin(opts) {
  const user = requireAuth(opts);
  if (user.role !== "admin") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Admin only." });
  }
  return opts.next({ ctx: { ...opts.ctx, user } });
});

export type ProtectedContext = { ctx: Context & { user: NonNullable<Context["user"]> } };
