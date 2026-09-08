-- Level 6 was called "Founder", which is not what a content creator becomes when
-- their channel starts paying — and not what a plumber, a shop or a freelancer
-- becomes either. "Owner" is the identity the whole site promises (the opposite
-- of employee), and it is true on every path.
--
-- This is also the last of the founder framing. The repositioning swept the
-- tables it knew about; these four strings sat in two it did not.

update founder_levels set
  title = 'Owner',
  unlock_text = 'Owner unlocked: the first sale was not luck. $100 earned, proof in hand, and the money kept somewhere of its own. You own a business.'
  where level = 6;

update founder_levels set unlock_text =
  'Maker unlocked: ten people pay you and part of the machine runs itself. You can now mentor members on lower rungs.'
  where level = 7;

update founder_levels set unlock_text =
  'LEGEND. Sustained revenue and a documented playbook published for the people still stuck where you started. The Blox track is open. You are the case study now.'
  where level = 10;

update predefined_milestones set description =
  'Answered the questions your Compass is drawn from — your hours, your runway, and what you will not do.'
  where title = 'Compass Questions Answered';

-- The Coach names the rung it is pointing at, so it has to follow the rename.
update guidance_rules set message =
  'Next rung — Level 6, Owner: earn your first $100, open a business bank account, collect 5 testimonials. Prove the first sale wasn''t luck.'
  where key = 'rung_to_6';

-- Level titles are stored per member nowhere — current_level is an integer and
-- the title is read from this table — so nobody's earned title is rewritten by
-- this. A member at Level 6 simply reads "Owner" from now on.
