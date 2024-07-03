import puppeteer from 'puppeteer-extra';
import {Page} from 'puppeteer';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import fs from 'fs';
import cheerio from 'cheerio';
puppeteer.use(StealthPlugin());

const endpoint = 'https://www.union-pool.com/calendar';

interface EventDetails {
  title: string | null;
  date: string | null;
  genre: string;
  time: string | null;
  location: string | null;
  price: string | null;
  image: string | null;
  excerpt: string | null;
  isFeatured: boolean;
  buyNowLink?: string;
}

let gigzArr: EventDetails[] = [];

const retry = async <T>(fn: () => Promise<T>, retries: number, delay: number): Promise<T> => {
  try {
    return await fn();
  } catch (error) {
    if (retries > 1) {
      await new Promise(resolve => setTimeout(resolve, delay));
      return retry(fn, retries - 1, delay);
    } else {
      throw error;
    }
  }
};

const processExcerpt = (excerpt: string | null, link: string | undefined = undefined): string => {
  let formattedExcerpt = '';

  if (excerpt !== null) {
    formattedExcerpt += `<p>${excerpt}</p><br><br><ul><li><a href='${link}'>BUY TICKETS</a></li></ul>`;
  }

  if (link && !excerpt) {
    formattedExcerpt += `<br><br><ul><li><a href='${link}'>BUY TICKETS</a></li></ul>`;
  } else if (!link && !excerpt) {
    formattedExcerpt = '';
  }

  return formattedExcerpt;
};

const formatDateStringForMongoDB = (dateString: string): string => {
  const currentYear = new Date().getFullYear();
  const date = new Date(`${dateString} ${currentYear}`);

  const isoString = date.toISOString();
  const datePart = isoString.split('T')[0];
  const timePart = '00:00:00.000';
  const timezoneOffset = '+00:00';

  return `${datePart}T${timePart}${timezoneOffset}`;
};

const dynamicScrollAndCollectLinks = async (page: Page, selector: string): Promise<{ link: string }[]> => {
  let links = new Set<string>();
  try {
    let previousSize = 0;
    let newSize = 0;
    do {
      previousSize = links.size;
      const newLinks = await page.$$eval(selector, (elements: Element[]) =>
        elements.map(el => {
          return {
            link: (el as HTMLAnchorElement).href
          };
        })
      );
      newLinks.forEach((item: { link: string }) => links.add(JSON.stringify(item)));
      newSize = links.size;
      if (newSize > previousSize) {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    } while (newSize > previousSize);
  } catch (error) {
    console.error('Error during dynamic scroll and link collection: ', error);
  }
  return Array.from(links).map(item => JSON.parse(item));
};

const scrapeEventDetails = async (page: Page, link: string): Promise<EventDetails | null> => {
  try {
    await retry(
      async () => {
        return await page.goto(link, { waitUntil: 'domcontentloaded' });
      },
      3,
      1000
    );

    let title: string | null = null,
      date: string | null = null,
      genre: string = '',
      time: string | null = null,
      location: string | null = null,
      price: string | null = null,
      image: string | null = null,
      excerpt: string | null = null,
      isFeatured = false,
      buyNowLink: string | undefined = undefined;

    try {
      title = await page.$eval('h1.EventDetailsTitle__Title-sc-8ebcf47a-0.iLdkPz', (el: Element) => el?.textContent?.trim() || null);
    } catch (err) {
      console.error(`Error finding title: `, err);
    }

    try {
      const dateTimeText = await page.$eval('div.EventDetailsTitle__Date-sc-8ebcf47a-2.hwEQMH', (el: Element) => el?.textContent?.trim() || '');
      const parts = dateTimeText.split(',');
      date = `${parts[0].trim()}, ${parts[1].trim()}`;
      time = parts[2].trim();
    } catch (err) {
      console.error(`Error finding date and time: `, err);
    }

    try {
      location = await page.$eval('div.EventDetailsTitle__Venues-sc-8ebcf47a-1 span', (el: Element) => el?.textContent?.trim() || '');
    } catch (err) {
      console.error(`Error finding location with first selector: `, err);
      try {
        location = await page.$eval('div[class="EventDetailsTitle__Venues-sc-8ebcf47a-1 cqBRcR"] a', (el: Element) => el?.textContent?.trim() || '');
      } catch (err) {
        console.error(`Error finding location with second selector: `, err);
      }
    }

    try {
      price = await page.$eval('div.EventDetailsCallToAction__PriceRow-sc-3e9a4f58-1 span', (el: Element) => el?.textContent?.trim() || '');
    } catch (err) {
      console.error(`Error finding price: `, err);
    }

    try {
      image = await page.$eval('img.EventDetailsImage__Image-sc-869461fe-1', (el: Element) => (el as HTMLImageElement).src);
    } catch (err) {
      console.error(`Error finding image: `, err);
    }

    try {
      excerpt = await page.$eval('div.EventDetailsAbout__Text-sc-6411bf4-1', (el: Element) => el?.textContent?.trim() || '');
    } catch (err) {
      console.error(`Error finding excerpt: `, err);
    }

    const genreKeywords: { [key: string]: string[] } = {
      'black metal': ['black metal'],
      metal: ['metal'],
      'nu metal': ['nu metal'],
      punk: ['punk'],
      'post punk': ['post punk', 'post - punk', 'post-punk'],
      'stoner rock': ['stoner rock'],
      'post rock': ['post rock', 'post - rock', 'post-rock'],
      rock: ['rock'],
      edm: ['edm'],
      synth: ['synth'],
      industrial: ['industrial'],
      pop: ['pop'],
      'hip-hop': ['hip-hop', 'hip hop'],
      oi: ['oi'],
      emo: ['emo'],
      other: ['other']
    };

    const findGenre = (text: string): string => {
      text = text.toLowerCase();
      for (const [genre, keywords] of Object.entries(genreKeywords)) {
        if (keywords.some(keyword => text.includes(keyword))) {
          return genre;
        }
      }
      return '¯\\_(ツ)_/¯';
    };

    genre = findGenre(excerpt || '');

    try {
      buyNowLink = await page.$eval('button.ButtonBase-sc-85d4fc6-0.Button-sc-809b25af-0.EventDetailsCallToAction__ActionButton-sc-3e9a4f58-5', (el: Element) => (el.closest('a') as HTMLAnchorElement).href);
    } catch (err) {
      console.error(`Error finding buy now link: `, err);
      buyNowLink = undefined;
    }

    buyNowLink = link || undefined;

    date = formatDateStringForMongoDB(date || '');
    excerpt = processExcerpt(excerpt, buyNowLink);

    return {
      title,
      date,
      genre,
      time,
      location,
      price,
      image,
      excerpt,
      isFeatured,
      buyNowLink
    };
  } catch (error) {
    console.error(`Error scraping details from ${link}: `, error);
    return null;
  }
};

(async () => {
  const browser = await puppeteer.launch({ headless: false });
  const page = await browser.newPage();

  try {
    await page.goto(endpoint, { waitUntil: 'domcontentloaded' });

    await page.waitForSelector('a.sc-iAvgwm.htFtqS.dice_book-now');

    const eventLinks = await dynamicScrollAndCollectLinks(page, 'a.sc-iAvgwm.htFtqS.dice_book-now');
    console.log(`Collected ${eventLinks.length} event links`);

    for (const { link } of eventLinks) {
      const gigDetails = await scrapeEventDetails(page, link);
      if (gigDetails) gigzArr.push(gigDetails);
    }

    console.log(`Scraped ${gigzArr.length} event details`);
  } catch (error) {
    console.error('Error during the main process: ', error);
  } finally {
    await browser.close();

    if (gigzArr.length) {
      fs.writeFileSync('events.json', JSON.stringify(gigzArr, null, 2), 'utf-8');
      console.log('Data saved to events.json');
    } else {
      console.log('No data to save.');
    }
  }
})();