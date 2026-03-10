const express = require('express');
const path = require('path');

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/**
 * Mock AI responses — simulates Claude with concept extraction.
 * Each response includes text and visual concepts.
 */
const MOCK_RESPONSES = {
  // Car/vehicle related
  car: {
    text: "I'd love to help you find the right vehicle! There are so many options to consider. Are you looking for a sedan, an SUV, or maybe something sportier? What matters most to you — fuel efficiency, space, performance, or style?",
    concepts: ['car', 'search'],
    followUp: {
      sedan: {
        text: "Great choice! Sedans offer a nice balance of comfort and efficiency. Some popular options include the Toyota Camry for reliability, the Honda Accord for its driving dynamics, or if you want something more premium, the BMW 3 Series or Mercedes C-Class. What's your budget range?",
        concepts: ['car', 'money']
      },
      suv: {
        text: "SUVs are versatile! For a compact SUV, the Toyota RAV4 and Honda CR-V are excellent. If you need more space, the Hyundai Palisade and Kia Telluride are outstanding. Do you need third-row seating or is two rows enough?",
        concepts: ['truck', 'person']
      }
    }
  },
  // Pet related
  pet: {
    text: "Looking for a pet? That's exciting! The most popular choices are dogs and cats, but there are so many wonderful animals to consider. Are you more of a dog person or a cat person? Or perhaps you're interested in something different?",
    concepts: ['dog', 'cat'],
    followUp: {
      dog: {
        text: "Dogs are wonderful companions! Consider your living situation — do you have a big yard or live in an apartment? Active breeds like Labs and Golden Retrievers need lots of exercise, while smaller breeds like French Bulldogs and Cavalier King Charles Spaniels are more apartment-friendly.",
        concepts: ['dog', 'house']
      },
      cat: {
        text: "Cats make fantastic pets! They're more independent than dogs but can be just as affectionate. Would you prefer a playful, active cat or a calm, cuddly lap cat? Indoor-only or will they have outdoor access?",
        concepts: ['cat', 'house']
      }
    }
  },
  // Travel
  travel: {
    text: "I love helping plan trips! Are you dreaming of mountains, beaches, or city exploration? And are you thinking domestic or international travel? The world is full of incredible destinations!",
    concepts: ['airplane', 'mountain'],
    followUp: {
      beach: {
        text: "Beach destinations are perfect for relaxation! The Maldives offers stunning overwater bungalows, while Bali combines beaches with rich culture. For something closer, consider the Caribbean or Hawaii. When are you planning to go?",
        concepts: ['boat', 'sun']
      },
      mountain: {
        text: "Mountain destinations offer breathtaking views and adventures! Switzerland's Alps are iconic, while Patagonia is raw and dramatic. In the US, Colorado and Montana have incredible mountain scenery. Do you enjoy hiking, skiing, or just the views?",
        concepts: ['mountain', 'tree']
      }
    }
  },
  // Food/cooking
  food: {
    text: "Food is such a wonderful topic! Are you looking for recipe ideas, restaurant recommendations, or tips on learning to cook? I can help with all of those. What kind of cuisine interests you most?",
    concepts: ['food', 'cup'],
    followUp: {}
  },
  // Music
  music: {
    text: "Music is a universal language! Are you looking to learn an instrument, discover new artists, or maybe create your own music? I can help with recommendations across any genre. What kind of music moves you?",
    concepts: ['guitar', 'star'],
    followUp: {}
  },
  // Books/reading
  books: {
    text: "I'm a big fan of reading! Are you looking for fiction, non-fiction, or something specific? I can recommend books based on your interests, whether it's science fiction, history, self-improvement, or literary fiction. What have you enjoyed reading recently?",
    concepts: ['book', 'search'],
    followUp: {}
  },
  // Technology
  tech: {
    text: "Technology is always evolving! Are you interested in the latest smartphones, computers, or perhaps emerging tech like AI and robotics? I can help you make sense of the options. What specific area of tech are you curious about?",
    concepts: ['computer', 'phone'],
    followUp: {}
  },
  // Home/housing
  home: {
    text: "Looking at homes is exciting! Are you buying, renting, or renovating? Location, size, and budget are the big three factors. Tell me more about what you're looking for and I can help narrow down what to consider.",
    concepts: ['house', 'key'],
    followUp: {}
  },
  // Default/greeting
  default: {
    text: "That's an interesting topic! I'd love to explore it with you. Could you tell me a bit more about what specifically you're interested in? I can help with research, recommendations, comparisons, and much more.",
    concepts: ['search', 'question'],
    followUp: {}
  },
  greeting: {
    text: "Hello! Welcome to the Thinking Canvas. I'm here to help you explore ideas — and as we talk, you'll see my thoughts taking shape on the canvas beside us. What would you like to explore today?",
    concepts: ['star', 'person'],
    followUp: {}
  }
};

/**
 * Simple keyword matching to select a response category.
 */
function categorize(message) {
  const m = message.toLowerCase();

  if (/^(hi|hello|hey|greetings|howdy|what'?s up)/i.test(m)) return 'greeting';
  if (/\b(car|vehicle|auto|sedan|suv|drive|driving|buy a car|new car)\b/.test(m)) return 'car';
  if (/\b(pet|dog|cat|puppy|kitten|animal|adopt)\b/.test(m)) return 'pet';
  if (/\b(travel|trip|vacation|flight|destination|visit|tour)\b/.test(m)) return 'travel';
  if (/\b(food|cook|recipe|restaurant|eat|dinner|lunch|meal)\b/.test(m)) return 'food';
  if (/\b(music|song|instrument|guitar|piano|band|concert)\b/.test(m)) return 'music';
  if (/\b(book|read|novel|story|author|library)\b/.test(m)) return 'books';
  if (/\b(tech|computer|phone|laptop|software|app|gadget|device)\b/.test(m)) return 'tech';
  if (/\b(home|house|apartment|rent|buy|moving|real estate)\b/.test(m)) return 'home';

  return 'default';
}

/**
 * POST /api/chat
 * Accepts: { message: string, history: array }
 * Returns: { text: string, concepts: string[] }
 */
app.post('/api/chat', (req, res) => {
  const { message, history } = req.body;

  if (!message) {
    return res.status(400).json({ error: 'No message provided' });
  }

  const category = categorize(message);
  const response = MOCK_RESPONSES[category] || MOCK_RESPONSES.default;

  // Check if this is a follow-up to a previous category
  let result = response;
  if (response.followUp && history && history.length > 2) {
    for (const [key, followUpResp] of Object.entries(response.followUp)) {
      if (message.toLowerCase().includes(key)) {
        result = followUpResp;
        break;
      }
    }
  }

  // Simulate thinking delay (500-1500ms)
  const delay = 500 + Math.random() * 1000;

  setTimeout(() => {
    res.json({
      text: result.text,
      concepts: result.concepts || ['question']
    });
  }, delay);
});

/**
 * POST /api/chat/stream
 * SSE endpoint for streaming responses
 */
app.post('/api/chat/stream', (req, res) => {
  const { message, history } = req.body;

  if (!message) {
    return res.status(400).json({ error: 'No message provided' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const category = categorize(message);
  const response = MOCK_RESPONSES[category] || MOCK_RESPONSES.default;

  let result = response;
  if (response.followUp && history && history.length > 2) {
    for (const [key, followUpResp] of Object.entries(response.followUp)) {
      if (message.toLowerCase().includes(key)) {
        result = followUpResp;
        break;
      }
    }
  }

  // Send concepts immediately (AI knows what it's thinking about)
  setTimeout(() => {
    res.write(`data: ${JSON.stringify({ type: 'concepts', concepts: result.concepts })}\n\n`);
  }, 300);

  // Stream text word by word
  const words = result.text.split(' ');
  let wordIndex = 0;
  const startDelay = 600 + Math.random() * 400;

  setTimeout(() => {
    const interval = setInterval(() => {
      if (wordIndex >= words.length) {
        clearInterval(interval);
        res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
        res.end();
        return;
      }

      const word = words[wordIndex] + ' ';
      res.write(`data: ${JSON.stringify({ type: 'text', text: word })}\n\n`);
      wordIndex++;
    }, 40 + Math.random() * 60); // 40-100ms per word
  }, startDelay);
});

app.listen(PORT, () => {
  console.log(`\n  Thinking Canvas is running!\n`);
  console.log(`  Open http://localhost:${PORT} in your browser\n`);
});
