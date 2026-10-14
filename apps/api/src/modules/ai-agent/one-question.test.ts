import { describe, it, expect } from "vitest";
import { QuestionLimiter } from "./one-question.js";

const f = (t: string) => new QuestionLimiter().filter(t);

describe("QuestionLimiter", () => {
  it("leaves a reply with one question, or none, exactly as it was", () => {
    for (const t of ["Saturday at 10 or 11:30. Which suits you?", "Your visit is booked for Saturday at 10.", "  Hello?  ", ""]) {
      expect(f(t)).toEqual({ text: t, dropped: false });
    }
  });

  it("keeps statements and the first question, drops the later questions", () => {
    const r = f("Saturday has 10, 11:30 and 2 pm. Which suits you? And is it 2 BHK or 3 BHK? What is your budget?");
    expect(r).toEqual({ text: "Saturday has 10, 11:30 and 2 pm. Which suits you?", dropped: true });
  });

  it("keeps a statement that follows the first question", () => {
    expect(f("Which slot? I will note it down. And the budget?").text).toBe("Which slot? I will note it down.");
  });

  it("works in Tamil, with the same question marks", () => {
    const r = f("சனிக்கிழமை 10 மணிக்கு, 11:30-க்கு இருக்கு. எது வசதி? அப்புறம் 2 BHK வேணுமா, 3 BHK-ஆ? உங்க budget என்ன?");
    expect(r.text).toBe("சனிக்கிழமை 10 மணிக்கு, 11:30-க்கு இருக்கு. எது வசதி?");
    expect(r.dropped).toBe(true);
  });

  it("an alternative that continues the same question is part of it", () => {
    expect(f("Would you like 10 o'clock? Or 11:30? And your budget?").text).toBe("Would you like 10 o'clock? Or 11:30?");
    expect(f("காலை 10 மணிக்கா? இல்ல மதியம் 2 மணிக்கா? பட்ஜெட் என்ன?").text).toBe("காலை 10 மணிக்கா? இல்ல மதியம் 2 மணிக்கா?");
  });

  it("is stateful across chunks of one reply", () => {
    const lim = new QuestionLimiter();
    expect(lim.filter("Which slot do you prefer?")).toEqual({ text: "Which slot do you prefer?", dropped: false });
    expect(lim.filter("And your budget?")).toEqual({ text: "", dropped: true });
    expect(lim.filter("I will note that.")).toEqual({ text: "I will note that.", dropped: false });
  });
});

describe("QuestionLimiter with questions already asked", () => {
  const asked = ["When are you planning to buy, and will you need a home loan?"];

  it("drops the same question asked again, keeps the answer around it", () => {
    const r = new QuestionLimiter(asked).filter("I am an AI assistant. When are you planning to buy, and will you need a home loan?");
    expect(r).toEqual({ text: "I am an AI assistant.", dropped: true });
  });

  it("keeps a different question, and a similar-looking one that asks something else", () => {
    expect(new QuestionLimiter(asked).filter("Would you like to visit the site on Saturday?").dropped).toBe(false);
    expect(new QuestionLimiter(["Do you need a loan?"]).filter("Do you need a visit?").dropped).toBe(false); // too short to judge
  });

  it("does nothing when nothing was asked before", () => {
    expect(new QuestionLimiter().filter("When are you planning to buy, and will you need a home loan?").dropped).toBe(false);
  });
});

