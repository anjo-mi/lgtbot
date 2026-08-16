import {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  Colors,
  DiscordAPIError,
  EmbedBuilder,
  SlashCommandSubcommandGroupBuilder,
} from 'discord.js';
import { logger } from './logger';

const MAX_EMOJIS_CODE = 30008;

export function getEmojiCommands() {
  return (group: SlashCommandSubcommandGroupBuilder) =>
    group
      .setName('symbols')
      .setDescription('Symbol management commands')
      .addSubcommand((sub) =>
        sub
          .setName('import-from')
          .setDescription('Import symbols from another server this bot is in')
          .addStringOption((opt) =>
            opt
              .setName('server-id')
              .setDescription('The ID of the server to import symbols from')
              .setRequired(true)
          )
          .addStringOption((opt) =>
            opt
              .setName('emoji-name')
              .setDescription(
                'Name of a specific symbol to import (imports all if omitted)'
              )
              .setRequired(false)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName('remove')
          .setDescription('Remove a symbol from this server')
          .addStringOption((opt) =>
            opt
              .setName('symbol')
              .setDescription('The symbol to remove')
              .setRequired(true)
              .setAutocomplete(true)
          )
      );
}

export async function handleEmojiCommand(
  interaction: ChatInputCommandInteraction
) {
  const subcommand = interaction.options.getSubcommand();
  switch (subcommand) {
    case 'import-from':
      await handleCloneFrom(interaction);
      break;
    case 'remove':
      await handleRemove(interaction);
      break;
  }
}

export async function handleEmojiAutocomplete(
  interaction: AutocompleteInteraction
) {
  const focused = interaction.options.getFocused().toLowerCase();
  const emojis = await interaction.guild!.emojis.fetch();

  const choices = emojis
    .filter(
      (e) => !focused || (e.name?.toLowerCase().includes(focused) ?? false)
    )
    .first(25)
    .map((e) => ({
      name: `:${e.name}:`,
      value: e.id,
    }));

  await interaction.respond(choices);
}

async function handleCloneFrom(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();

  const sourceGuildId = interaction.options.getString('server-id')!;
  const targetGuild = interaction.guild!;

  let sourceGuild;
  try {
    sourceGuild = await interaction.client.guilds.fetch(sourceGuildId);
  } catch {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle('Unknown server')
          .setColor(Colors.DarkRed)
          .setDescription("I'm not a member of that server.")
          .setTimestamp(),
      ],
    });
    return;
  }

  const [sourceEmojis, targetEmojis] = await Promise.all([
    sourceGuild.emojis.fetch(),
    targetGuild.emojis.fetch(),
  ]);

  const targetEmojiNames = new Set(
    targetEmojis
      .map((e) => e.name)
      .filter((name): name is string => name !== null)
  );

  const duplicates: string[] = [];
  const toClone = [];
  for (const emoji of sourceEmojis.values()) {
    if (emoji.name && targetEmojiNames.has(emoji.name)) {
      duplicates.push(emoji.name);
    } else {
      toClone.push(emoji);
    }
  }

  const targetName = interaction.options.getString('emoji-name');
  if (targetName) {
    const match = sourceEmojis.find(
      (e) => e.name?.toLowerCase() === targetName.toLowerCase()
    );
    if (!match) {
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.DarkRed)
            .setTitle('Symbol not found')
            .setDescription(
              `**${targetName}** doesn't exist in **${sourceGuild.name}**.`
            )
            .setTimestamp(),
        ],
      });
      return;
    }
    if (duplicates.includes(match.name!)) {
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.DarkGold)
            .setTitle('Already exists')
            .setDescription(`**${match.name}** already exists in this server.`)
            .setTimestamp(),
        ],
      });
      return;
    }
    toClone.splice(0, toClone.length, match);
    duplicates.length = 0;
  }

  if (toClone.length === 0) {
    const description =
      duplicates.length === 0
        ? `**${sourceGuild.name}** has no custom symbols.`
        : `All symbols from **${sourceGuild.name}** already exist in this server.`;
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(Colors.DarkGold)
          .setTitle('Nothing to import')
          .setDescription(description)
          .setTimestamp(),
      ],
    });
    return;
  }

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.DarkGold)
        .setTitle('Importing symbols...')
        .setDescription(
          `Processing **${toClone.length}** symbol(s) from **${sourceGuild.name}**`
        )
        .setTimestamp(),
    ],
  });

  let transferred = 0;
  const failed: string[] = [];

  for (const emoji of toClone) {
    const imageUrl = emoji.imageURL();
    if (!imageUrl) {
      failed.push(emoji.name ?? emoji.id);
      continue;
    }

    try {
      await targetGuild.emojis.create({
        attachment: imageUrl,
        name: emoji.name!,
      });
      transferred++;
    } catch (error) {
      const name = emoji.name ?? emoji.id;
      if (error instanceof DiscordAPIError && error.code === MAX_EMOJIS_CODE) {
        failed.push(name);
        break;
      }
      logger.error(error, `Failed to import symbol ${name}`);
      failed.push(name);
    }
  }

  const fields = [];
  if (duplicates.length > 0) {
    fields.push({
      name: `Skipped — ${duplicates.length} duplicate${duplicates.length === 1 ? '' : 's'}`,
      value: duplicates.join(' • '),
    });
  }
  if (failed.length > 0) {
    fields.push({
      name: `Failed — ${failed.length}`,
      value: failed.join(' • '),
    });
  }

  const allFailed = transferred === 0 && failed.length > 0;
  const embed = new EmbedBuilder()
    .setColor(allFailed ? Colors.DarkRed : Colors.DarkGreen)
    .setTitle(allFailed ? 'Import failed' : 'Symbols imported!')
    .setDescription(
      `Imported **${transferred}** symbol(s) from **${sourceGuild.name}**`
    )
    .setTimestamp();

  if (fields.length > 0) embed.addFields(fields);

  await interaction.editReply({ embeds: [embed] });
}

async function handleRemove(interaction: ChatInputCommandInteraction) {
  const emojiValue = interaction.options.getString('symbol')!;
  const guild = interaction.guild!;

  const allEmojis = await guild.emojis.fetch();

  // compare against names instead of id's, protect against mid-command-entry navigation
  const cleanName = emojiValue.replace(/^:+|:+$/g, '');
  const emoji =
    allEmojis.get(emojiValue) ?? allEmojis.find((e) => e.name === cleanName);

  if (!emoji) {
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle('Not found')
          .setColor(Colors.DarkRed)
          .setDescription("That symbol doesn't exist in this server.")
          .setTimestamp(),
      ],
      ephemeral: true,
    });
    return;
  }

  const name = emoji.name ?? emojiValue;
  await emoji.delete();

  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setTitle('Symbol removed')
        .setColor(Colors.DarkGreen)
        .setDescription(`**${name}** has been removed.`)
        .setTimestamp(),
    ],
  });
}
