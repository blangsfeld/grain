---
id: 2b3b19dd-2c29-462f-9d01-21ebb14a78ce
source_title: 'Ai MCP discussion'
source_date: 2026-03-16
source_type: transcript
created_at: 2026-03-21T17:10:47.932004+00:00
word_count: 6302
participants: [{"name":"Ben","email":"ben@residence.co","is_owner":true},{"name":"John Kleber","email":"john.kleber@residence.co","is_owner":false},{"name":"Madison","email":"madison@residence.co","is_owner":false},{"name":"Doug Wilkinson","email":"doug@buck.co","is_owner":false}]
archived_from: dx_transcripts (source_v2 legacy)
---

# Ai MCP discussion

Ai MCP discussion
Date: 2026-03-16

Them: He is a layer that allows for LLMs to take advantage of subsets of the API in a structured way.
Them: That's like the loose. The most loose way of doing it. So you can do all sorts of great stuff with it, but the most basic thing is to act as, like, a middleware layer.
Them: Between.
Them: The actual application and the LLMs just makes it easier for LLMs to talk instead of having.
Them: To go and do API calls and API keys and blah, blah, blah.
You: They're like translators.
Them: So a bunch of these companies that already have APIs have started writing their own MCP service.
Them: Which you can integrate into.
Them: As a tool into.
Them: Your vibe coding situation.
Them: Slack like everybody else has their own MCP tool, allows you to do a subset of the things that you would be able to do.
Them: With the API if you have.
Them: Wide open API key.
Them: There's a bunch of.
Them: And so the different now, when I'm talking about agentic coding, it's sort of like a hand wavy term.
Them: That is saying you have, as a person, you have delegated some actions.
Them: To an LLM with the capability of writing code.
Them: On an hn. You are acting as my agent, right? And so how it works in practice?
Them: Is like you give it a prompt.
Them: And it goes and does stuff.
Them: These have gotten much more sophisticated in recent months, so there's, like, lots of agents that can be spun up simultaneously. The effect is that.
Them: These agents can be.
Them: Acting in an orchestrated or semi autonomous, or in some cases purely autonomous fashion.
Them: Okay, purely autonomous is like taking it too far, but you can set up jobs that prompt the agents to run away. That it has the effect of being autonomous. It's not truly autonomous, but for all intents and purposes, it might as well be.
Them: So quad code.
Them: Gemini, the Big Three have all had integrations into slack for a very long time.
Them: MCP has been something that's been available for about a year and a half. And it's something that if you knew how to write an MCP tool, you could have done this a very long time ago. Anyway, a bunch of these companies started adding MCP tools out there.
Them: The existing code.
Them: LLM coding platforms were already integrated into Slack, now suddenly have the capability to just integrate Slack's MCP layer, which means.
Them: While these agentic systems have been now made available to something like Claude, like spinning up multiple agents. Now, all of those agents have access to the MCP tools that you give them access to, which means they can easily have scope drift.
Them: My concern I highlighted to you, Madison, was.
Them: In slack today because we've inherited all the permissions that Claude Code had a year ago. But now we have all these capabilities that Claude didn't have a year ago.
Them: When you click the button that they just added last week to allow AI agents into your slack, what it asks you to do is add the slack MCP to your quad like program. You just click a button and add slack mcp. So now what does that mean in practice?
Them: Nothing new.
Them: That could be done two weeks ago. Except the friction for somebody who doesn't know what they're doing has been radically lowered. So any person could just, say, be in a bunch of private panels and dms and all this other stuff.
Them: And set up agentic workflows.
Them: Things that could work seemingly autonomously and pull stuff out of slack or put stuff into slack in ways that used to have this barrier entry.
Them: Not a huge problem.
Them: On its surface. But when you start thinking about people who might have inherited permissions over the course of years of working at Buck and these tools, inheriting permissions that are, as you know, Madison from the conversations with Slack.
Them: They obey our existing permissions like they always say. They just obey your channels like the way it works the same way with all the slack AI tools do.
Them: This inheritance problem, like metastasize, is very rapidly. And so Doug and Kevin Walker came to me.
Them: The week before last. We're like, hey, this new feature is in Slack. You can just press this button and add an agentic workflows into Slack. And they're like, maybe we should be thinking about the security ramifications. And that's sort of what prompted me doing some thinking about it.
Them: And I wrote to you the same thing that I wrote to the Buck executive team, which is basically like, hey, I have some concerns about this.
Them: That's all. Like, it was not like. Well, and also, I think maybe we should turn off the part that just makes it so it's immediate, like.
Them: There's that little Chiclet button you could press and just, like, add it.
Them: I just was saying we should just turn that part off for now while we figure out.
Them: Effectively. What's our data protection structure now that this inheritance problem becomes very widely available to people?
Them: And just last thing I'll say, I set up, just by way of demonstration from Core Engineering, I set up an adaptive workflow outside of Slack on my personal computer that just, like, bombarded it with, like, ran every single person with completely random LLM instant messages for, like, you know, two minutes straight. And it was. Like all hyper personalized, like conversations we had had just to like, show them how easily you could just be like, oh, do a thing right. So, like, in theory.
Them: Someone could, like, set up a workflow. It's like, send a personal email to everybody that I have, everybody in Slack that's personalized to any conversation I had, and do that.
Them: On some like timed cave and sneaky to set the prawn job. It'll do it.
Them: Not thinking that anyone's necessarily going to do that, but having seen in the past, people are leaving. They, like, do, like, crazy things, like, there's all sorts of stuff.
Them: That could happen with bad actors.
Them: I'm also worried about people who just have good intentions, like suddenly exfiltrating a bunch of conversations their local laptop and not even realizing.
Them: It.
Them: Because we've just inherited all these permission. So that's where I was coming from. There's no, like, no one should be doing this. Energy coming from here. It's more like we need to talk about this. That's where I've got.
Them: That's all background. I, Doug, might want to fill in gaps.
Them: I mean, I want to use it.
Them: I want to use it, but I'm also don't want anyone else to use. It's like one of those things, you know, where you're like,
Them: This is really dangerous.
Them: People who are like, should I trust myself with it? You know? But there's, like, a lot of value that could potentially come from the ability to, like, grab technical conversations that, for example, like the TVs and I have had and slap that right into, like, a chat bot and turn it around and give people, like, an incredible amount of insight, you know, really quickly.
You: Yeah. I mean, ways I've been using it is just like summarizing channels that I can't look at. Like, it takes all my leads channels and summarizes them. And now Slack can do that. Everyone's trying to chase the same features.
You: But there is opportunities for me to create reports from like, we have a margin channel that reviews margins. And I took the whole year's history and made this comprehensive report of why margins dip. What's the story, what the category is. But I'm thinking of it as a smart actor and a thoughtful actor, not a bad actor, so I totally get. You know, you could get hit by a car by crossing the street.
You: But I think the way you described it, John is really savvy in that. Like, it just got really easy to do it. So you can just like your first experiment.
You: Could just be a typo and, like, do something pretty bad.
You: But, you know, that could happen to anyone. Even me. But, like, at least I'm like, wait.
You: I've got keys. What am I going to do with it? What would John do in this scenario? Like, I have you in the back of my head, you know, and. But I don't know if, like, some designer does, right?
Them: I mean, also, I want to be very clear that, like, the other thing that's important here is that these MCP servers and services are things that we very easily can build into play ourselves in a controlled way. And.
Them: Like, I think that there's a part of this conversations where it's like, what? What kind of adoption do we launch? We want to be just grabbing a bunch of off the shelf stuff and getting.
Them: Dug into it, or do we want to do what a lot of people are doing who are savvy. Have been doing so far, which is like writing very specific things that pull the things that they, they want out. Right. Like the agentic workflow that's been added in.
Them: Slack.
Them: Has been there.
You: Yeah, yeah. It's just like, button new, like, shortcuts to get there.
Them: 's a new shortcut to do it.
Them: So a lot of this is like, we're not prepared or we could be better prepared for the governance problem. And like Doug absolutely. As the, you know, the head of departments should be able to take uses discretion to remove certain types of things and place them into other like reconstitute that information.
Them: That being said,
Them: Our company is very, very senior.
Them: And.
Them: A lot of people make the error, and I see this happen every day.
Them: Because they're habituated to having access to these things, assuming that that access is not as highly sensitive as you would as an independent person. So, like, the sort of adage of, like, leaks happening from the top is some. This is one of the things where it's, like, I'm most concerned about.
Them: I might not even realize because I have so much access that we have, like an embargo on anthropic or whatever right now.
Them: You know, and, like, I could build a tool where it's like, I just accidentally surfaced a bunch of information to people on my team that were not, like, about. I'm just making shit up right now. But, you know, that's my point. It's like. It's like. So if we look at. Somebody like.
Them: I don't know, like, Daniel Effinger, right? Like, he's, like, very, very senior and has, like, probably massively broad access.
Them: I'm just using him as an example of someone who's not sitting in this room. Like, he could just as easily, like, make a. Like, a summary of all of his chats.
Them: I don't know. You know, don't take saying it's like, this is not a personal thing. I'm just sort of like, illustrated. Like, is that what that level of access? They're the people who make accidental. They're the ones who in the four times did all the leaks and they're. The ones who are going to be the easiest exposed. Like, if all that stuff is on a computer.
Them: And I've already seen this. You could sign up with a different email and just connect your Slack MCP server to it.
Them: Like, you know, there's lots of weird shit you can do. Pulling stuff into Claude and not realizing it. Like, that stuff will stick around. And Claude in your Claude account might be set up with whatever, you know. John Dou at Acme Co.
You: Could you also just fill me in, like on? Because when I came to you guys for user auth, for slack,
You: I had to ask for permission. I had to give a little reason why I did it. And through the slack side of it.
You: Not even the claw. You don't have to do anything. So are you proposing something similar where, like, people have to be, like, just sort of explain their intent, and then we have, like, a group of people that, like, probably the heads of that, like, need to help validate that this person is up to good things?
Them: It's less about approving people and more about trying to understand how we take stock with what's already been approved.
Them: Because, like,
Them: If you just use the Slack MCP tool as it's designed.
Them: You don't have so much access that you can, like, go into private channels or go into, like, archive. It doesn't, like, give you the same amount of access, like, six months ago that when we gave you an API key, we had to be very careful.
Them: About making sure that you couldn't have rewrite in certain places. MCP actually does a really good job in this specific case, like making it so you can't do anything destructive to the system.
Them: Doesn't mean you can't like acting like a jerk is still totally available to you.
Them: In Slacker via mcp. It's like, those kind of things are like, I'm not worried about acting like a jerk. I'm more worried about, like,
Them: John Kleber was shared on all of the companies Google Docs when he joined the company, which I was. And I don't know what the access permissions are on all those docs. And it's entirely possible that my inheritance of those permissions as like a senior leadership means that my Gemini agent could theoretically just bork a drive and I have no idea.
Them: Like, because, I mean, I screw things up. And Claude and Gemini all the time not realizing that I've done it.
Them: Right? You know, it's like, oh, I just deleted the database. I did that last week.
Them: You know. Oops. Actually, I didn't delete it.
Them: I was using a model that was too stupid to, like, check.
Them: The guys using haiku instead of sonnet. Right. And so it just threw away the database and, like, those kind of things.
Them: If I was connected to my Google Drive account, which I do absolutely use connectors in my environment to connect to Google.
Them: Drives. If you suddenly have an MCP tool that has unfettered access, you could do a thing. I'm not saying that that's what slacks can do today. What I'm saying is, like, we're at a point where we, as the thinkers of controllers of this information, also advocates for Doug and I are, like, extremely aggressively advocating for using agentic AI tools like within, and we're asking people to come to us and show us what they're working on.
Them: We kind of have to, as a group, be like, hey.
Them: What kind of structure do we have in place?
Them: How do we audit this? Can we audit it? Should we on.
Them: Do we wait for something to happen? I'm. I'm just sort of, like, saying to guys, hey, signal flare.
Them: Like this is, like, exceeded my brain's capacity to think laterally about. I remember when we said like a couple years ago and we reaffirmed it again.
Them: That we want every. You know, like, we want everybody trying things out and be creative and use all the things. And then we did the. We did, like, a vibe coding thing recently, earlier this year.
Them: I wonder if it's time to, like, say, good job, everybody, but, like, but also, like, there's.
Them: There's a lot of people are kind of self. They're, they're creating. They're creating these investment projects and then go. Going and building that. They're green lighting them and building them. And we're funding it because like we're reimbursing and they might a lot of times. They're not checking with anyone. You know what I mean? They're not. Which is cool. Like, they're authentically exploring.
Them: It's awesome. But. But on the other hand.
Them: So I think there's, like, a number of things that feel.
Them: There's the security aspect, and then there's also the like, do I know what this person has been doing that they've been working, like, late nights and weekends? It's affecting their.
Them: Productivity and.
Them: What is this thing they're even making? You know, kind of thing. There's a little bit of that, like.
You: Are you singling me out there with that statement?
Them: I.
Them: If you feel singled out by that, I apologize. But that actually is. I didn't. I didn't realize that you were. How you even. Have you been like, staying. Anyway, I feel the. I feel like being drawn into it. I feel that I'm personally being drawn into it. I speak for myself. I can speak. For the few people that sit around me.
Them: As well, because they're. They're also, like, very deeply.
Them: Their accelerationists and.
You: Yeah. So. So talk to me about. So talk to me about what happens tomorrow. So do you, like, take that away from all of us? Like, are we then not doing that?
You: Or, you know, how do what is. I understand the idea of, like, a reset.
Them: Like, what's the middle path here?
You: Right? Yeah. So, like, what does next week look like is what I'm kind of. Because I understand where we need to get to. Right. I understand we don't have the answers. Now, it did get very easy to just, like.
You: I'm going to see. I'm going to make a supabase full of all the slack, right?
You: What's the middle ground? Where the people who are actively trying. Shit.
You: We don't know who they all are. To your point. Like, it could be some random animator who's building some empire of vive coating, right?
You: Doubt it, but there. There could be a good 50 people that are, like, building something every day.
Them: My answer to that is.
Them: We do what we would in any sort of, like, program that introduces governance, which is, like, we take stock.
Them: With what we have.
Them: We establish what we want the ground rules to be, and then we just start working through how we keep, like, how we remediate whatever might be a problem. Like if we say, here, here's an example.
Them: At some point in the past.
Them: I've worked at companies where if someone took all. If a salesperson took all of their contacts,
Them: Dumped all of their contacts to their personal laptop. It could be grounds for dismissal. I'm not saying that Buck should do that, but, like, that was just a rule, right? Like it was a rule that took place at certain companies, like.
Them: So we sort of have to figure out, like, is this something that is inbounds or out of bounds for whom?
Them: And. And Ben also. We have to be like, okay.
Them: These types of client engagements.
Them: Or these types of job folders or these types of Google Drives. We have to look at all the permission schemas and say, okay, well, Kevin hall, you need to go through every single production share drive and fix, make everyone a viewer.
Them: Or like, whatever. Like, I don't know. It's about establishing. Rather than being like, we're going to turn everything off and you're all screwed, is instead being like, we as a company need to decide.
Them: What's high risk, medium risk and low risk. What's high value and low value? And then we work through it. Not us.
Them: But our teams, and we try not to restrict people just by being like, here's a battering ram to take down. You know, the thing that you've been working on. Because what I don't want to do is stop Kevin hall from building his calendaring app, which is massively helpful to him or.
Them: Anybody. Daniel Pernicoff, who's, like, submitted, like, this incredible thing to code club that we're trying to operationalize. Like, we have so many valuable things that are coming in from people who are doing really intense things, and we have a way to look and be like, oh, this might not be good for security. We should put this through Cloudflare or whatever.
Them: We're like, hey, you know, did you get this? Or that? But I think that we just need to.
You: Yeah. I wonder if there's, like,
Them: Decide.
You: Thinking of, like, a skill we could write that's.
You: Like how to like. In order to get authorization, you have to load this skill into your platform that says this is what's inbound and out of bound for any engagements.
Them: Yeah, that was one of the things that Doug and I were toying with early on was like, you know, putting model. Sorry, putting context or prompt logic into people's ide or whatever.
Them: I feel like you're describing what you're describing, though, John, is.
Them: Super like.
Them: We have to figure out a way that people can. Can do this.
Them: Who have no who are not going to become.
Them: Technical directors or whatever you want to call them, they're not going to become developers.
Them: This is like artists using computers to that point.
Them: We need to make sure that our Google Drives and stuff like that.
Them: Like shares.
Them: Are actually rock solid because we want to allow a junior person to hook up the Google MCP in the Claude.
Them: Like plugin to their slack or whatever and do and go ham without worrying that they're going to leak something, that's all.
Them: Can we offer us. Can we offer. I don't know if this is realistic, but, like, can we. Which, if we have the ability to switch certain things off, can we turn something on internally where we have complete control over what we're providing? So, like.
You: Like. Like, child permissions on their phone. Can we have, like, child permissions on the mcp?
Them: Like we couldn't have our own router. And it's like you just point everything you're making to your point about skill. Like, why are you trying to hit Slack directly? That's not how we do it at Buck. You must not have read the thing. You need to connect to the one place and you go in with this setting, and you have to, like, tell people you're doing. You know what I mean? Like, we can. It's basically like.
Them: In. In an artist set, and in the artist analogy, it's like you went off and made, like, a whole new character for this spot.
Them: And you're just, like, showing us now, like, what have you been. What does even do it like?
Them: Wait a minute. Like, I think there's a little bit of that. That. That is how that has been happening. And if we can put in some gates that are actually also, like, entryways, you know, like, this is the right. This is the front door you're using. It's not.
Them: It's not like the one don't the slack mcp like we should try to figure out how to turn that stuff off and then like procure and produce stuff that.
You: It is probably going, probably turning off the MCP and going and authorizing the APIs with, like, really good restrictions.
You: And guardrails on what's available.
Them: Something like that.
You: API.
Them: Like, where we get to pick and choose who and why. We could build an mcp, a Buck MCP or Residence MCP that could do all that stuff for all our apps.
You: Y.
You: Eah.
Them: That is something that can be done, but that's, like, not a. Like that.
Them: 's not a one week project or next week practice. It's like several months project. In the meantime, slack has the mechanism.
You: Yeah.
Them: Like, right now, we just sort of approve whatever comes through, right? Like Gotham just, like, click, approve, approve. And so, like, that's where the inheriting things, it's like people install Claude like a year ago.
Them: And it inherited all these new permissions, I mean, these existing permissions, while gaining all these new capabilities. And so.
Them: I'm saying, like, without having to turn everything off, things that feel like they're a higher threat surface are like Google Drive. And then going forward, maybe we're a little more judicious about clicking approved for every new thing that comes in. And the goal is like, let's tighten control around our data.
Them: A little bit more.
Them: We need to think about this.
Them: I'm sort of asking for help, like, thinking about this, right? And then, like, where, you know, Ben, like, what. Have you seen that? Where you're like, oh, I have a lot of access here. Like, I need. I'm sort of like. It's sort of like a refactor, request for comment kind of thing. And we. We say, okay, you know, a few weeks from now, like, we think that these are surfaces we want to close down, make not close down, like, make tighter. And then we sort of make a task force do that if it's complicated or we just do it ourselves.
You: Yeah, that's interesting, you know.
Them: All the while, we're building an mcp layer to talk to our API layer.
You: Yeah, I think the. The MCP layer to talk to MPI could be relevant. My fear was, like, we won't be able to keep up with the model's abilities, but, like, we only have a. We don't have a huge tool set. Like, we only have, like, 10 things that really matter to us. Where we're not on Monday, we're not on at you, we're not on these other products that we don't really care about. So we can just make our ecosystem our data set.
You: Here are the calls that you're allowed.
You: Right? And through the mcp, it's like. And they're like, obvious ones, right? You can do this, you can do that, you can't do that, right?
You: That to me, gets to a place that I get pretty excited.
You: Because I've actually writing a memo that we do need this. Like, we need. We need a bridge between core engineering and everyone trying to vibe code something, right?
You: And it needs to just be, like, a threat, like a door, a gate.
You: You can walk through. And this is the way it happens. These are the. This is the database we use. This is the way we can do this.
Them: That. That's part. That's the. The. The beginning, little seedling of that is.
Them: Only a week or so old between ARG and with John as well.
You: Great.
Them: Like. Like we're. We're trying to develop. Yeah. A system where you can.
You: Yeah, exactly. Right, like you guys are.
Them: You can say that you have a thing and you want to. You actually want to operationalize it, and then it goes in and like, Cameron looks like we're in that channel and we can look at it. It's not fast by any means right now, but we're also, like, doing this for the first time.
You: Y.
Them: As we do it, so.
Them: I think what we're doing is starting to create a pipeline for people who are builders to be able to submit.
Them: And we can make it, you know, fast and frictionless.
Them: As possible over time, but right now, it feels like it needs to be. We need to understand what people are even trying to do.
Them: And the access that they're wanting.
You: Eah. So I'm I'm, now that I understand the sort of the intent, I do feel more comfortable with like a more near term shutdown or clamp down, shall we call it? And then, you know, and but it's a very clear communication that like if you have had access and you're like in the middle of a project, just reach right out. We will green light it again, but we just don't know what we don't know, and we just need to have, like.
You: Zero. And then we. We can go from there. And it's like, we're not, like, shutting it down. We're just, like, taking stock, starting over, doing over. And then, you know, you can get. You will get you back up and running tomorrow, kind of like a license.
Them: Yeah, we're not going to shut anything off. I think.
Them: It would be just give you more judicious and try to work work out.
Them: So.
Them: The thing that you're describing, the you might be writing.
Them: A proposal in vain because.
Them: Doug and I have.
Them: Gotten the ARG and Core Engineering have started working fully with Buck API, which I don't know if you've ever.
You: I've seen it. Yeah, you showed it to me.
Them: Yeah.
Them: Well, when we showed it to Cameron was like, oh, right. So it's like a developer who knows what to do with it. It sort of changes the whole entire ecosystem.
Them: For them. So all of those things you described, like having an easier way for our teams to interact with.
Them: What actually is more than 200, like, end points.
Them: We can move that into model context if we want to, and we can make it a subset of a subset with the right permissions. We're just in the early days where ARG is finally understanding something that core engineering has been pitching.
You: Right there. Finally. You finally showed them the keys, and they're like, holy shit, it's a lot of keys.
Them: Yes. And that's the thing that we. We. We could just say, go hit API buck local. If you're on the production network and if you know what you're doing.
Them: Then you're good.
Them: Right.
Them: And that's, like, kind of where we were.
Them: And today it's. It's more.
Them: It's more like, well.
Them: We wouldn't want to give API buck local to like everybody with unfettered, you know. Now, you can do a lot of stuff in the API that doesn't. It's not destructive.
Them: But.
Them: Still. Still, it's pretty wide open. You could, like, post stuff to Deltec.
Them: If you have to write permission, set up.
Them: But when you say that we don't have a lot of connections, it's like actually anything that has software in our ecosystem has been integrated into Buck API to some degree.
Them: So we actually have, like,
Them: For operational people. It's a very different control surface than who creative people might use. So we might want to have MCPs that are specifically designed for. Exactly. And so.
You: For certain people. Yeah, like the slack drive Claude mcp. Right. Grab that one.
Them: Ben, if you remember, when I presented the Buck OS model back in October, November of last year,
Them: That mcp layer with the API layer underneath.
Them: This is what that design was going towards, so we're trying to operationalize it.
Them: And we're not trying to turn off anything. What we're actually trying to do is make it so you can have your selection of context, your selection of models, your select, like. And it can be on prem or in the cloud. It's like this. It's really massively scalable.
You: That's.
You: Great.
Them: What I'm just trying to prevent from happening right now is entrenchment.
Them: Of certain tools that have too much broad access to existing permission scheme. That's it. That's nothing. Nothing. Like, I just don't want people to be like, oh.
You: Yeah.
Them: Boop. I'm just going to add whatever the heck I want and have unfettered access to the Google.
Them: Drive and just, like, make asset management library, which is, like, what people want to do.
Them: That kind of thing should have enough friction. So they go to ARG and say, hey, we want a digital asset management tool. I'm getting blocked here.
You: Y.
You: Eah, here's. Here's one I've made with fake data. How do we get access?
Them: Exactly like I know as badly everyone wants to use real data like.
Them: You can do this with fake data.
Them: It works as well.
You: Okay?
You: I'm on board. I think just like trying to be as explicit about our intent as possible, and anything that we amplify out will be important because I just don't want people to misread this as we're shutting it down, it's more just like we're shutting it down. To create really good access to it, you know?
Them: I think.
Them: Maybe, Ben, you and I could workshop what that messaging is. And I think if it came from the two of us from a residence level, like, this is the commitment that we're making, like a technology creative commitment.
Them: It will resonate in a way that's, like, really, really effective. Because I think that. I think that. I know I run into this perception that there's a desire from technology, something down. That's not the desire. It's actually. I like the anarchic thing because it gives us lots of signal. And lowers the noise quite a bit. So it'd be good to work with you, especially in your new role. Be like, this is how we message it. Because what I don't think we need to do is make a tech announce that says, hey, we're going to turn off access to blah that doesn't. Get anywhere because it's going to affect four people.
Them: But then they create a big stick instead. What I'll just say to Gotham gently is like, hey.
Them: Check with me if there's anything that has, like, new. Like, if you're going to install something new into Slack, if it has, like, these capabilities, just double check with me.
Them: Before you do it.
Them: And we'll just try to be a little bit more judicious about it. So maybe today's Monday. I'll try to put time on our calendar for you, me, Ben, to, like, hone some of this language, because I think if we came out with, like, a position statement for, like, this is what. Resonance is doing.
You: Yep.
You: We're basically setting this up to be keys to the kingdom.
Them: About this world.
Them: We're building, like, a context there. Yes, we're building a context and an API at scale.
Them: It is. We've tested it at buck. The a cat layer is test network. The layer doesn't exist. It's very small. We're now testing implementations with arg using the API.
Them: So it's on the road.
You: Perfect.
Them: Now. So I think that we. The bigger message is the commitment to experimentation.
You: Agreed.
You: Awesome. Thank you. Thank you for humoring us. We were, you know, Madison and I were in this off site, and we just wanted to have this conversation to catch up.
Them: All right.
You: And I feel really good about where we landed, so thank you.
Them: We will not take away Wade's Codex access for his Excel spreadsheets.
You: Did. He is. They are so in cowork. Oh, my God.
Them: I want to learn from them.
Them: How do we. They only have. There's only one person who's installed the Excel plugin.
Them: Just. Vish. Just so you know, I don't want to know about the Excel token.
You: They're using cowork. That's what they.
Them: I'd be interested to know what they're doing in Cowork, but I'll get it through the channels.
You: Cool.
Them: Whenever. It's. Yeah. That's awesome.
You: I have a client meeting in the morning tomorrow. I'm flying in the evening. I'm speaking at a conference on Wednesday, back Thursday.
You: But there's some time in there tomorrow. But maybe just, like, try to riff on some of the themes you want to talk about, and then even just send me, like, a table of context and I'll be on a plane. Maybe I could do some writing and stuff like that.
Them: Sure.
Them: Yep. I think you just keep it simple and direct. I'll send you my ideas.
You: Cool. Great. Thank you. Appreciate it, guys.
Them: Okay. Thank you. How's that feel? We good? Yeah, it feels good. I'm interested in how this goes out to residents versus just Buck.
Them: But we can work through that.
Them: Yeah.
Them: Yeah, I think we could start with Buck and just, you know.
You: Yeah, yeah.
Them: All right. Thank you.
Them: All right, See you guys.
You: All.
You: Right.
