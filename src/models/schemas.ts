import { z } from "zod";

const basePromptSchema = z.object({
  prompt: z.string().min(1),
  seed: z.number().int().optional(),
});

export const imageFastInputSchema = basePromptSchema;
export const imageFastOutputSchema = z.object({
  images: z.array(
    z.object({
      url: z.string().url(),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      content_type: z.literal("image/png"),
    }),
  ),
  prompt: z.string(),
  seed: z.number(),
});

export const videoFastInputSchema = basePromptSchema;
export const videoFastOutputSchema = z.object({
  video: z.object({
    url: z.string().url(),
    content_type: z.literal("video/mp4"),
    file_name: z.string().min(1),
  }),
  prompt: z.string(),
  seed: z.number(),
});
