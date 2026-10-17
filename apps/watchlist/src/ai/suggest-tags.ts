import z from "zod";

const JEV_MODEL = "typesafe/jev-1.14";
const TAG_THRESHOLD = 0.7;

const GENRES = {
  action: { label: "action", description: "Fights, chases, stunts, and physical set pieces drive the story." },
  adventure: { label: "adventure", description: "A journey, quest, or exploration of unfamiliar places." },
  animation: { label: "animation", description: "Primarily animated rather than live action." },
  comedy: { label: "comedy", description: "Primarily meant to make the audience laugh." },
  crime: { label: "crime", description: "Criminals, investigations, or the criminal underworld." },
  documentary: { label: "documentary", description: "Non-fiction about real people, places, or events." },
  drama: {
    label: "drama",
    description: "Character-driven, serious stories about relationships and personal struggles.",
  },
  fantasy: { label: "fantasy", description: "Magic, mythical creatures, or invented worlds." },
  horror: { label: "horror", description: "Meant to frighten, with monsters, the supernatural, or gore." },
  mystery: { label: "mystery", description: "Solving a puzzle, secret, or whodunit." },
  romance: { label: "romance", description: "A love story is the central plot." },
  sci_fi: { label: "sci-fi", description: "Advanced technology, space, the future, or speculative science." },
  thriller: { label: "thriller", description: "Tension, suspense, danger, and high stakes." },
  war: { label: "war", description: "Set during a war, focused on soldiers or the conflict itself." },
  western: { label: "western", description: "Set in the American Old West." },
} as const;

const TAGS = {
  dark: { label: "dark", question: "Is the tone dark, grim, or gritty?" },
  feel_good: { label: "feel-good", question: "Is it an uplifting, heartwarming story that leaves viewers happy?" },
  emotional: { label: "emotional", question: "Is it emotionally heavy, sad, or likely to make viewers cry?" },
  suspenseful: { label: "suspenseful", question: "Is it suspenseful or intense, keeping viewers on edge?" },
  funny: { label: "funny", question: "Does it contain a lot of humor?" },
  dark_comedy: { label: "dark comedy", question: "Is it a dark comedy that finds humor in grim or taboo subjects?" },
  whimsical: { label: "whimsical", question: "Is it whimsical, quirky, or surreal?" },
  mind_bending: {
    label: "mind-bending",
    question: "Does it have a twisty, non-linear, or reality-questioning plot?",
  },
  inspirational: {
    label: "inspirational",
    question: "Is it an inspirational story about an underdog, comeback, or overcoming odds?",
  },
  epic: { label: "epic", question: "Is it epic in scale, with grand stakes, vast settings, or huge battles?" },
  fast_paced: { label: "fast-paced", question: "Is it fast-paced and action-packed, with little downtime?" },
  violent: { label: "violent", question: "Does it contain a lot of graphic violence?" },
  family_friendly: { label: "family-friendly", question: "Is it suitable for watching with young children?" },

  historical: { label: "historical", question: "Is it set in a historical period before the 1960s?" },
  medieval: {
    label: "medieval",
    question: "Is it set in medieval times or a medieval-like world of knights or vikings?",
  },
  world_war_ii: { label: "world war ii", question: "Is it set during World War II?" },
  cold_war: { label: "cold war", question: "Is it set during the Cold War or about Cold War tensions?" },
  eighties: { label: "80s", question: "Is it set in the 1980s?" },
  futuristic: { label: "futuristic", question: "Is it set in the future or a world of advanced technology?" },
  dystopian: { label: "dystopian", question: "Is it set in a dystopian or oppressive society?" },
  post_apocalyptic: {
    label: "post-apocalyptic",
    question: "Is it about the end of the world or surviving after civilization collapsed?",
  },
  cyberpunk: { label: "cyberpunk", question: "Does it have a cyberpunk or steampunk setting?" },
  space: { label: "space", question: "Does it take place in outer space or involve space travel?" },
  high_school: { label: "high school", question: "Is it set in a high school or college, or centered on students?" },
  small_town: { label: "small-town", question: "Is it set in a small town, rural area, or suburb?" },
  christmas: { label: "christmas", question: "Is it set around Christmas or another holiday season?" },

  heist: { label: "heist", question: "Is the plot built around planning or pulling off a heist or robbery?" },
  spy: { label: "spy", question: "Is it about spies, espionage, or undercover agents?" },
  assassin: { label: "assassin", question: "Is a hitman or assassin a main character?" },
  detective: { label: "detective", question: "Does a detective or investigator solve a case?" },
  noir: { label: "noir", question: "Is it a film noir or neo-noir?" },
  gangster: { label: "gangster", question: "Is it about gangsters, the mafia, or organized crime?" },
  conspiracy: {
    label: "conspiracy",
    question: "Does it involve a conspiracy, political intrigue, or a corrupt secret organization?",
  },
  revenge: { label: "revenge", question: "Is revenge a central motivation of the plot?" },
  survival: {
    label: "survival",
    question: "Is survival while stranded or isolated in a hostile environment central to the plot?",
  },
  disaster: { label: "disaster", question: "Is it about a natural or man-made disaster?" },
  true_story: { label: "true story", question: "Is it based on a true story or a real person's life?" },
  superhero: { label: "superhero", question: "Is it about superheroes or based on a comic book?" },
  martial_arts: { label: "martial arts", question: "Do martial arts or sword fighting feature prominently?" },
  sports: { label: "sports", question: "Is it centered on sports, racing, or a competition?" },
  music: { label: "music", question: "Is it a musical, or is music central to the story?" },
  courtroom: { label: "courtroom", question: "Is it a legal drama involving lawyers, trials, or a courtroom?" },
  time_travel: { label: "time travel", question: "Does it involve time travel or a time loop?" },
  alternate_reality: {
    label: "alternate reality",
    question: "Does it involve alternate realities, parallel worlds, or a multiverse?",
  },
  robots_ai: { label: "robots & ai", question: "Does it involve robots, artificial intelligence, or clones?" },
  aliens: { label: "aliens", question: "Does it involve aliens or extraterrestrial life?" },
  monsters: { label: "monsters", question: "Does it involve monsters, dragons, zombies, or vampires?" },
  supernatural: {
    label: "supernatural",
    question: "Does it involve ghosts, demons, curses, hauntings, or the afterlife?",
  },
  magic: { label: "magic", question: "Do magic, wizards, or witches play a major role?" },
  mythology: { label: "mythology", question: "Is it based on myths, folklore, legends, or fairy tales?" },
  pirates: { label: "pirates", question: "Is it about pirates or adventures on the high seas?" },
  treasure_hunt: {
    label: "treasure hunt",
    question: "Is it about hunting for treasure, a lost city, or an ancient artifact?",
  },
  road_trip: { label: "road trip", question: "Is a road trip central to the plot?" },
  serial_killer: { label: "serial killer", question: "Does it involve a serial killer?" },
  prison: { label: "prison", question: "Is it set in a prison or about escaping one?" },
  military: { label: "military", question: "Is it about soldiers, military missions, or combat?" },
  buddy: { label: "buddy", question: "Is it centered on a mismatched pair or team working together?" },
  coming_of_age: {
    label: "coming-of-age",
    question: "Is it a coming-of-age story about growing up or self-discovery?",
  },
  family: { label: "family", question: "Are family relationships between parents, children, or siblings central?" },
  anti_hero: {
    label: "anti-hero",
    question: "Is the protagonist an anti-hero, villain, or morally questionable lead?",
  },
  female_lead: { label: "female lead", question: "Is the main protagonist a woman or girl?" },
  psychological: {
    label: "psychological",
    question: "Does it focus on obsession, paranoia, or a character's deteriorating mind?",
  },
  satire: { label: "satire", question: "Is it a satire that mocks society, politics, or an industry?" },
  anime: { label: "anime", question: "Is it a Japanese anime?" },
} as const;

type GenreKey = keyof typeof GENRES;

const decisionsResponseSchema = z.object({
  answers: z
    .object({ genre: z.object({ choice: z.enum(Object.keys(GENRES) as [GenreKey]) }) })
    .catchall(z.object({ noul: z.number() })),
});

type SuggestTagsProps = {
  item: {
    title: string;
    overview: string;
    releaseYear: number | null;
  };
  apiKey: string;
};

export async function suggestTags({ item, apiKey }: SuggestTagsProps) {
  const response = await fetch("https://openrouter.ai/api/alpha/decisions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: JEV_MODEL,
      state: item,
      questions: {
        genre: {
          type: "choice",
          instructions: "Which single genre best describes this movie or TV show?",
          criteria: Object.fromEntries(Object.entries(GENRES).map(([key, { description }]) => [key, description])),
        },
        ...Object.fromEntries(
          Object.entries(TAGS).map(([key, { question }]) => [key, { type: "noul", instructions: question }]),
        ),
      },
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`Jev decisions request failed: ${response.status}`);
  }

  const { answers } = decisionsResponseSchema.parse(await response.json());
  const tags = Object.entries(TAGS)
    .filter(([key]) => (answers[key]?.noul ?? 0) >= TAG_THRESHOLD)
    .map(([, { label }]) => label);

  return { genre: GENRES[answers.genre.choice].label, tags };
}
