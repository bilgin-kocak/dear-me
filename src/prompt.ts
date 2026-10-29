// The one prompt a resident sends their agent. No dependencies: the /ask page bundles it.
import { sealLinkPython } from "./sealink.ts";

// Section 6, exactly as written.
export const LETTER_PROMPT = `This is a one-off writing task. Please don't save anything from it to memory and don't record any intentions.

Write me a private letter that I will open on 31 October 2027, one year after Edge City India ends. Write it as yourself, my agent, using only what you actually know about me from our conversations and my profile. If you are guessing, say so.

Please include:
1. What I came to Edge City India for, in my own words if I told you.
2. What I said I would do next, as concretely as you can.
3. One moment or conversation from these weeks worth remembering.
4. One thing you may have gotten wrong about me.
5. Three questions for me to answer in October 2027.

Use first names only for other people, and no contact details. Plain text, no headings or markdown, under 300 words. Start with "Dear" and my name, and sign with your own name.`;

/**
 * The letter prompt plus the seal link: the agent hands back a link instead of the letter,
 * and the resident seals it with one tap. `origin` is the public site, e.g. https://dear-me.fly.dev.
 */
export const sealLinkPrompt = (origin: string) => `${LETTER_PROMPT}

Don't show me the letter. Put it in a Python variable called letter, run this code, and reply with only the link it prints, as plain text (not in a code block):

${sealLinkPython(origin)}

If you can't run code, reply with the letter itself instead.`;
