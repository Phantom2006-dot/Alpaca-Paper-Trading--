// Export your models here. Add one export per file
// export * from "./posts";

import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const alpacaCredentials = pgTable("alpaca_credentials", {
	userId: text("user_id").primaryKey(),
	encryptedApiKey: text("encrypted_api_key").notNull(),
	encryptedApiSecret: text("encrypted_api_secret").notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type AlpacaCredentialRecord = typeof alpacaCredentials.$inferSelect;
//
// Each model/table should ideally be split into different files.
// Each model/table should define a Drizzle table, insert schema, and types:
//
//   import { pgTable, text, serial } from "drizzle-orm/pg-core";
//   import { createInsertSchema } from "drizzle-zod";
//   import { z } from "zod/v4";
//
//   export const postsTable = pgTable("posts", {
//     id: serial("id").primaryKey(),
//     title: text("title").notNull(),
//   });
//
//   export const insertPostSchema = createInsertSchema(postsTable).omit({ id: true });
//   export type InsertPost = z.infer<typeof insertPostSchema>;
//   export type Post = typeof postsTable.$inferSelect;

export {}