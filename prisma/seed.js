const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log('Seeding minimal data...');
  const dir = await prisma.directory.create({
    data: {
      name: 'Sample Directory',
      path: '/sample/path',
      parsedName: 'Sample Directory',
      parsedYear: 2025,
      parsedType: 'movie',
      specialName: null,
      tmdbId: null,
      tmdbStatus: null,
      libraryAdded: false,
      libraryPath: null,
      metadata: JSON.stringify({ seeded: true }),
      files: {
        create: [
          {
            name: 'example.mp4',
            path: '/sample/path/example.mp4',
            size: BigInt(1234567)
          }
        ]
      }
    },
    include: { files: true }
  });

  console.log('Seeded directory id:', dir.id);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
