import express from "express";
import Sequelize from "sequelize";
import slugify from "slugify";

let router = express.Router();

import models from "../models";
import { authenticate, authenicatePublicRequest } from "../utils/jwt";
import { csvItems, packItemPayload, packPayload } from "../utils/build-payload";

// Get public packs
router.get("/public", async (req, res) => {
  models.Pack.findAll({
    where: { public: true },
    attributes: ["id", "title", "updatedAt"],
  })
    .then((packs) => {
      const urls = packs.map((pack) => ({
        loc: `${pack.id}/${slugify(pack.title, {
          replacement: "-",
          lower: true,
        })}`,
        lastmod: pack.updatedAt,
      }));

      return res.json(urls);
    })
    .catch((err) => res.json(err));
});

async function getPackById(id) {
  return await models.Pack.findOne({
    where: { id },
    include: [
      {
        model: models.Item,
        through: { where: { packId: id } },
        include: [
          {
            model: models.Category,
            as: "Category",
            attributes: ["id", "name", "level", "exclude_weight"],
          },
        ],
      },
      { model: models.User, attributes: ["id", "username"] },
    ],
  });
}

// Get
router.get("/:id", authenicatePublicRequest, async (req, res) => {
  let { id } = req.params;

  try {
    const pack = await getPackById(id);
    if (pack.public) {
      res.json(pack);
    } else {
      // when the pack is private, only allow the owner of the pack to view
      if (req.user && pack.userId == req.user.id) {
        res.json(pack);
      } else {
        res.sendStatus(403); // return 'forbidden'
      }
    }
  } catch (e) {
    res.json(e);
  }
});

// Get pack-view data
router.get("/view/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const pack = await getPackById(id);
    if (!pack.public) {
      res.sendStatus(403);
    }

    // organize items by category
    const categories = [];
    pack.items.forEach((item) => {
      const category = categories.find((cat) => cat.id === item.categoryId);
      if (category) {
        category.items.push(item);
      } else {
        categories.push({
          id: item.categoryId,
          category: item.Category,
          items: [item],
        });
      }
    });

    res.json({ pack, categories })

  } catch (e) {
    res.json(e);
  }
});

// Get user packs
router.get("/user/:id", async (req, res) => {
  let { id } = req.params;
  models.Pack.findAll({
    where: { userId: id },
    include: [{ model: models.User, attributes: ["id", "username"] }],
    attributes: Object.keys(models.Pack.rawAttributes).concat([
      [
        Sequelize.literal(
          '(SELECT COUNT(*) FROM "packItems" WHERE "packItems"."packId" = "pack"."id")'
        ),
        "itemCount",
      ],
    ]),
  })
    .then((packs) => res.json(packs))
    .catch((err) => res.json(err));
});

// Create
router.post("", authenticate, (req, res) => {
  const { payload } = packPayload(req.body);
  const { items, ...pack } = payload;

  // create pack
  models.Pack.create({ userId: req.user.id, ...pack })
    .then((pack) => {
      // associate items by id
      const assocItems = items.map((item) => ({
        ...item.packItem,
        quantity: item.packItem.quantity || 1,
        packId: pack.id,
        itemId: item.id,
      }));
      models.PackItem.bulkCreate(assocItems)
        .then(() => {
          // retrieve new pack w/ items
          models.Pack.findOne({
            where: { id: pack.id },
            include: {
              model: models.Item,
              through: { where: { packId: pack.id } },
            },
          })
            .then((pack) => res.json(pack))
            .catch((err) => res.json(err));
        })
        .catch((err) => res.status(400).json(err));
    })
    .catch((err) => res.status(400).json(err));
});

// Update
router.put("", authenticate, (req, res) => {
  const { id, payload } = packPayload(req.body);
  const { items, ...pack } = payload;

  models.Pack.update(pack, {
    returning: true,
    where: { id, userId: req.user.id },
  })
    .then(([rowsUpdated, [updatedPack]]) => {
      if (!rowsUpdated) {
        return res.status(400).json({ error: "Pack not found." });
      }

      models.PackItem.destroy({ where: { packId: id } })
        .then(() => {
          const assocItems = items.map((item) => ({
            ...item.packItem,
            quantity: item.packItem.quantity || 1,
            packId: id,
            itemId: item.id,
          }));
          models.PackItem.bulkCreate(assocItems)
            .then(() => {
              // retrieve new pack w/ items
              models.Pack.findOne({
                where: { id },
                include: {
                  model: models.Item,
                  through: { where: { packId: id } },
                },
              })
                .then((pack) => res.json(pack))
                .catch((err) => res.json(err));
            })
            .catch((err) => res.status(400).json(err));
        })
        .catch((err) => res.status(400).json(err));
    })
    .catch((err) => res.status(400).json(err));
});

router.get("/export/:id", authenticate, async (req, res) => {
  const { id: userId } = req.user;
  let { id } = req.params;
  try {
    const pack = await models.Pack.findOne({
      where: { userId, id },
      include: [
        {
          model: models.Item,
          through: { where: { packId: id } },
          include: [
            { model: models.Category, as: "Category", attributes: ["name"] },
          ],
        },
      ],
    });
    res.csv(csvItems(pack.items), true);
  } catch (e) {
    res.status(400).json(e);
  }
});

// Delete
router.post("/delete", authenticate, (req, res) => {
  const { packId } = req.body;
  models.Pack.destroy({ where: { id: packId, userId: req.user.id } })
    .then(() => res.json(packId))
    .catch((err) => res.status(400).json(err));
});

// Associate pack-item
router.post("/add-item", authenticate, (req, res) => {
  const { payload } = packItemPayload(req.body);

  // verify ownership
  models.Pack.findOne({ where: { id: payload.packId, userId: req.user.id } })
    .then((pack) => {
      if (!pack) {
        return res.sendStatus(401);
      }
    })
    .catch((err) => res.status(400).json(err));

  // create association
  models.PackItem.create(payload)
    .then((packItem) => res.json(packItem))
    .catch((err) => res.status(400).json(err));
});

// Remove pack-item association
router.post("/remove-item", authenticate, (req, res) => {
  const {
    payload: { packId, itemId },
  } = packItemPayload(req.body);

  // verify ownership
  models.Pack.findOne({ where: { id: packId, userId: req.user.id } })
    .then((pack) => {
      if (!pack) {
        return res.sendStatus(401);
      }
    })
    .catch((err) => res.status(400).json(err));

  // remove association
  models.PackItem.destroy({ where: { packId, itemId } })
    .then((rowsUpdated) => res.json(rowsUpdated))
    .catch((err) => res.status(400).json(err));
});

// make a copy of a pack and its items
router.post("/copy-pack", authenticate, (req, res) => {
  const { packId } = req.body;

  // verify ownership
  if (packId) {
    models.Pack.findOne({ where: { id: packId, userId: req.user.id } })
      .then((pack) => {
        if (!pack) {
          return res.sendStatus(401);
        } else {
          //owner of pack is making request
          models.Pack.findOne({
            where: { id: packId },
            include: [
              {
                model: models.Item,
                through: { where: { packId: packId } },
                include: [
                  {
                    model: models.Category,
                    as: "Category",
                    attributes: ["name"],
                  },
                ],
              },
            ],
          })
            .then((pack) => {
              models.Pack.create({
                ...pack,
                userId: req.user.id,
                title: "Copy of " + pack.title,
              })
                .then((newPack) => {
                  //associate items by id
                  const assocItems = pack.items.map((item) => ({
                    ...item.packItem,
                    quantity: item.packItem.quantity || 1,
                    packId: newPack.id,
                    itemId: item.id,
                  }));
                  models.PackItem.bulkCreate(assocItems)
                    .then(() => {
                      // retrieve new pack w/ items
                      models.Pack.findOne({
                        where: { id: newPack.id },
                        include: {
                          model: models.Item,
                          through: { where: { packId: newPack.id } },
                        },
                      })
                        .then((pack) => res.json(pack))
                        .catch((err) => res.json(err));
                    })
                    .catch((err) => res.status(400).json(err));
                })
                .catch((err) => res.status(400).json(err));
            })
            .catch((err) => res.json(err));
        }
      })
      .catch((err) => res.status(400).json(err));
  }
});

module.exports = router;
