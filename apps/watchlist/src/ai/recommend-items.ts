import { generateText, type LanguageModel, Output } from "ai";
import z from "zod";
import { buildRecommenderPrompt } from "./prompts/recommender.prompt";

const recommendationSchema = z.object({
  recommendations: z.array(
    z.object({
      title: z.string(),
      type: z.enum(["movie", "tv"]),
      reason: z.string(),
    }),
  ),
});

export type AiRecommendation = z.infer<typeof recommendationSchema>["recommendations"][number];

type TasteProfile = {
  likedItems: Array<{ title: string; type: string; tags: string[]; userRating: number | null }>;
  dislikedPatterns: Array<{ title: string; negativeTags: string[] }>;
  tagPreferences: Record<string, number>;
  existingTitles: string[];
  mediaTypePreference: "movie" | "tv" | "both";
};

type RecommendItemsProps = {
  tasteProfile: TasteProfile;
  model: LanguageModel;
  customPrompt?: string;
};

export async function recommendItems({ tasteProfile, model, customPrompt }: RecommendItemsProps) {
  const prompt = buildRecommenderPrompt({
    likedItems: JSON.stringify(tasteProfile.likedItems),
    dislikedPatterns: JSON.stringify(tasteProfile.dislikedPatterns),
    tagPreferences: JSON.stringify(tasteProfile.tagPreferences),
    existingTitles: JSON.stringify(tasteProfile.existingTitles),
    mediaTypePreference: tasteProfile.mediaTypePreference,
    customPrompt,
  });

  const result = await generateText({
    model,
    prompt,
    output: Output.object({ schema: recommendationSchema }),
  });

  return result.output;
}
