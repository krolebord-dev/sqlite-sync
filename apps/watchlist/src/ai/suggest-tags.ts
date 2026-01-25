import { generateText, type LanguageModel, Output } from "ai";
import z from "zod";
import { buildClassifierPrompt } from "./prompts/classifier.prompt";

type SuggestTagsProps = {
  item: {
    title: string;
    overview: string;
  };
  model: LanguageModel;
};

export async function suggestTags({ item, model }: SuggestTagsProps) {
  const prompt = buildClassifierPrompt(item);
  const result = await generateText({
    model,
    prompt,
    output: Output.object({
      schema: z.object({
        genre: z.string(),
        tags: z.array(z.string()),
      }),
    }),
  });
  return result.output;
}
