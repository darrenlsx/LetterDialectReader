# Letter reader: product brief
**In one line:** Help an elderly person who cannot read English understand a government letter, in the dialect they speak.

## Problem
Elderly people who cannot read English cannot read the government letters that arrive in English. They were not educated in English, so the letters go unread and important information gets missed. They already own smartphones, so the gap is nothing that reads the letter in a language they understand.

## Evidence
- "Damn it, can't read", said in one of their Hokkien
- The people you have in mind own a smartphone.
- The letters are government issued and arrive in English.

## Success
- **Metric:** minutes for them to understand the letter when they opened it up
- **Today:** Infinite minutes by themselves, as not possible. Or hours if their next help is unavailable.
- **Target:** Translation and summary given within 5 minutes
- **Must not get worse:** Must be able to translate accurately, as they are rely on this app. Inform them if unable to translate confidently.

## Riskiest bet
Elderly non-English readers will photograph a government letter themselves rather than wait for a family member to read it.
- **Test:** Give 3 non-English speaking elderly an English letter, without mentioning or showing the app, and watch. Note whether they reach for their own phone.
- **Pass mark:** 2 of the 3 reach for their own phone, unprompted.
- **Result:** not run yet

## First version
1. As an elderly person who cannot read English, I choose my dialect from a list read out to me. Done when I hear my dialect and it is remembered next time.
2. As an elderly person holding an English letter, I photograph it. Done when I see a tick, or a cross and hear what went wrong.
3. As an elderly person, I hear the summary right after. 

## Walkthrough
1. They open the app; it speaks the dialect list in sequence and shows it in Chinese. They pick one, or last time's choice is set.
2. Photo mode shows a box for the letter. They take the picture.
3. A tick or a cross appears. On a cross they hear "Photo was blurry. Please take the picture again." and retake.
4. On a tick they hear the summary in their dialect.

If it goes wrong: the cross and the spoken message say the photo was blurry and ask them to take it again; if translation fails, a spoken prompt asks them to try once more. On-screen text is in Mandarin, speech is in their dialect.

## Not building
- No stored history of past letters.
- Nothing beyond government letters.
- No dialect beyond the three above.

## Open questions
- The app is untested here; trust in the reading over asking family, and accuracy in the dialects, are later bets.
- Where the 10-minute figure comes from, and what they hear if translation fails.
