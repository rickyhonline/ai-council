export type Advisor = {
  id: string;
  name: string;
  role: string;
  color: string;
  initials: string;
  instructions: string;
  voiceURI?: string;
  elevenVoiceId?: string;
};
export type Message = {
  id: string;
  speaker: string;
  text: string;
  createdAt: string;
};
export type Board = {
  problem: string;
  ideas: string[];
  questions: string[];
  options: string[];
  tradeoffs: string[];
  decisions: string[];
};
export type Session = {
  id: string;
  title: string;
  messages: Message[];
  board: Board;
  updatedAt: string;
  lastTurn?: {
    invited: string[];
    reason: string;
    participation: Record<string, number>;
  };
};
